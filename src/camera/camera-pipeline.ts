import { BackgroundPlate, DEFAULT_STATUS, PipelineStatus, SnapSettings } from '../shared/types';
import { ParticleEffect } from '../effects/particles';
import { DisappearanceEffect } from '../effects/disappearance-effect';
import { BackgroundManager } from './background-manager';
import { Compositor } from './compositor';
import { PerformanceManager } from './performance-manager';
import { PersonSegmenter, SegmentationFrame } from './person-segmenter';

export type PipelineEvent =
  | { type: 'STATUS'; status: PipelineStatus }
  | { type: 'BACKGROUND_CAPTURED'; background: BackgroundPlate }
  | { type: 'BACKGROUND_DELETED' }
  | { type: 'ERROR'; error: string };

export type PipelineEventHandler = (event: PipelineEvent) => void;

export class CameraPipeline {
  private readonly compositor = new Compositor();
  private readonly backgroundManager = new BackgroundManager();
  private readonly segmenter = new PersonSegmenter();
  private readonly performance = new PerformanceManager();
  private readonly particles = new ParticleEffect();
  private readonly disappearance = new DisappearanceEffect();
  private readonly onEvent: PipelineEventHandler;
  private inputStream: MediaStream | null = null;
  private inputVideoTrack: MediaStreamTrack | null = null;
  private outputStream: MediaStream | null = null;
  private outputVideoTrack: MediaStreamTrack | null = null;
  private outputAudioTracks: MediaStreamTrack[] = [];
  private video: HTMLVideoElement | null = null;
  private frameHandle = 0;
  private running = false;
  private attachQueue: Promise<void> = Promise.resolve();
  private modelInitStarted = false;
  private assetBaseUrl = '';
  private latestMask: SegmentationFrame | null = null;
  private lastWidth = 0;
  private lastHeight = 0;
  private mismatchCheckPending = false;
  private lastMismatchCheck = 0;
  private lastStatusSent = 0;
  private lastToggleAt = 0;
  private cameraEnabled = true;
  private settingsValue: SnapSettings;
  private status: PipelineStatus = { ...DEFAULT_STATUS };

  constructor(settings: SnapSettings, onEvent: PipelineEventHandler) {
    this.settingsValue = { ...settings };
    this.onEvent = onEvent;
    this.performance.setMode(settings.performanceMode);
  }

  async setAssetBaseUrl(assetBaseUrl: string): Promise<void> {
    this.assetBaseUrl = assetBaseUrl;
    if (this.settingsValue.realTimeRemoval) await this.ensureModel();
  }

  async setSettings(settings: SnapSettings): Promise<void> {
    const realtimeWasEnabled = this.settingsValue.realTimeRemoval;
    this.settingsValue = { ...settings };
    this.performance.setMode(settings.performanceMode);
    if (!settings.realTimeRemoval) this.latestMask = null;

    if (settings.realTimeRemoval && (!realtimeWasEnabled || !this.segmenter.ready)) {
      await this.ensureModel();
    }
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

  async attach(stream: MediaStream, videoConstraints?: MediaTrackConstraints): Promise<MediaStream> {
    const operation = this.attachQueue.then(() => this.attachInternal(stream, videoConstraints));
    this.attachQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async attachInternal(stream: MediaStream, videoConstraints?: MediaTrackConstraints): Promise<MediaStream> {
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) return stream;

    const candidateVideo = document.createElement('video');
    const outputAudioTracks: MediaStreamTrack[] = [];
    candidateVideo.muted = true;
    candidateVideo.playsInline = true;
    candidateVideo.autoplay = true;
    candidateVideo.srcObject = stream;

    try {
      for (const audioTrack of stream.getAudioTracks()) outputAudioTracks.push(audioTrack.clone());
      const widthHint = getConstraintNumber(videoConstraints?.width, 640);
      const heightHint = getConstraintNumber(videoConstraints?.height, 480);
      const frameRateHint = Math.min(60, Math.max(15, getConstraintNumber(videoConstraints?.frameRate, 30)));
      await waitForVideo(candidateVideo, 900);
      const width = candidateVideo.videoWidth || widthHint;
      const height = candidateVideo.videoHeight || heightHint;
      if (!width || !height) throw new Error('The camera returned no usable video dimensions.');

      // Prepare the new source before replacing the active session. If this
      // fails, the caller can safely continue with its original stream.
      // Keep audio clones from the previous Meet stream alive during a camera
      // switch. Meet may request a video-only replacement while continuing to
      // use the existing microphone track.
      this.stop();
      this.compositor.resize(width, height);
      const captureStream = this.compositor.canvas.captureStream(frameRateHint);
      outputAudioTracks.forEach((track) => captureStream.addTrack(track));
      const outputVideoTrack = captureStream.getVideoTracks()[0] ?? null;
      if (!outputVideoTrack) throw new Error('The processed camera stream has no video track.');
      this.inputStream = stream;
      this.inputVideoTrack = videoTrack;
      this.video = candidateVideo;
      this.outputStream = captureStream;
      this.outputVideoTrack = outputVideoTrack;
      this.outputAudioTracks = [...this.outputAudioTracks, ...outputAudioTracks];
      this.outputVideoTrack.contentHint = videoTrack.contentHint;
      this.cameraEnabled = true;
      stream.getAudioTracks().forEach((track) => track.stop());
      this.latestMask = null;
      this.lastWidth = width;
      this.lastHeight = height;
      this.status.cameraAvailable = videoTrack.readyState === 'live';
      this.status.pipelineInitialized = true;
      this.status.cameraRoute = 'processed';
      this.status.error = null;
      this.status.message = 'Processed camera track is ready for Google Meet.';
      this.emitStatus(true);

      videoTrack.addEventListener('ended', () => {
        if (this.inputVideoTrack === videoTrack) this.stop();
      }, { once: true });
      videoTrack.addEventListener('mute', () => {
        if (this.inputVideoTrack === videoTrack) this.stop();
      }, { once: true });
      outputVideoTrack.addEventListener('ended', () => {
        if (this.outputVideoTrack === outputVideoTrack) this.stop();
      }, { once: true });
      this.running = true;
      this.scheduleFrame();

      if (this.settingsValue.realTimeRemoval) void this.ensureModel();
      return captureStream;
    } catch (error) {
      outputAudioTracks.forEach((track) => track.stop());
      candidateVideo.pause();
      candidateVideo.srcObject = null;
      // Keep the original stream alive: the page bridge returns it as the safe fallback.
      this.status.cameraAvailable = videoTrack.readyState === 'live';
      this.status.message = 'Camera processing failed; Meet is using the original camera.';
      this.emitStatus(true);
      throw error;
    }
  }

  async captureBackground(): Promise<BackgroundPlate> {
    if (!this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      throw new Error('Turn on the Meet camera before capturing a background.');
    }
    if (this.status.effectActive) {
      throw new Error('Reappear before capturing so the hidden frame is not saved.');
    }

    const width = this.compositor.canvas.width || this.video.videoWidth;
    const height = this.compositor.canvas.height || this.video.videoHeight;
    const background = this.backgroundManager.capture(this.video, width, height);
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

  toggleEffect(): void {
    if (!this.video || !this.outputStream || !this.cameraEnabled || this.outputVideoTrack?.readyState !== 'live') return;
    const now = performance.now();
    if (now - this.lastToggleAt < 550) return;
    this.lastToggleAt = now;
    const nextHidden = !this.status.effectActive;
    this.status.effectActive = nextHidden;
    const transition = nextHidden ? 'disappear' : 'reappear';

    if (this.settingsValue.animations) {
      this.disappearance.start(transition, 360);
      this.particles.start(transition, this.compositor.getMaskBounds(this.latestMask), this.settingsValue.animationIntensity);
    } else {
      this.disappearance.start(transition, 1);
    }
    this.status.message = nextHidden ? this.hiddenMessage() : 'You are visible again.';
    this.emitStatus(true);
  }

  stop(options: { releaseOutputAudio?: boolean } = {}): void {
    if (!this.inputStream && !this.outputStream && !this.video && this.outputAudioTracks.length === 0) return;
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.video?.pause();
    if (this.video) this.video.srcObject = null;
    this.outputVideoTrack?.stop();
    this.inputVideoTrack?.stop();
    if (options.releaseOutputAudio) {
      this.outputAudioTracks.forEach((track) => track.stop());
      this.outputAudioTracks = [];
    }
    this.outputStream = null;
    this.outputVideoTrack = null;
    this.inputStream = null;
    this.inputVideoTrack = null;
    this.video = null;
    this.cameraEnabled = true;
    this.latestMask = null;
    this.status.cameraAvailable = false;
    this.status.pipelineInitialized = false;
    this.status.cameraRoute = 'waiting';
    this.status.effectActive = false;
    this.status.usingBackgroundPlate = false;
    this.status.message = 'Waiting for Google Meet camera';
    this.emitStatus(true);
  }

  dispose(): void {
    this.stop({ releaseOutputAudio: true });
    this.segmenter.close();
    this.modelInitStarted = false;
    this.assetBaseUrl = '';
  }

  routeVideoTrack(track: MediaStreamTrack): MediaStreamTrack {
    if (track.kind !== 'video' || track === this.outputVideoTrack) return track;
    return track === this.inputVideoTrack && this.outputVideoTrack?.readyState === 'live' ? this.outputVideoTrack : track;
  }

  markOriginalFallback(): void {
    if (this.outputStream && this.outputVideoTrack?.readyState === 'live') {
      this.status.message = 'A secondary camera request stayed on the original track; the active processed route remains available.';
      this.emitStatus(true);
      return;
    }
    this.status.cameraRoute = 'original';
    this.status.cameraAvailable = true;
    if (!this.outputStream) this.status.pipelineInitialized = false;
    this.status.message = 'Meet is using the original camera because local processing failed.';
    this.emitStatus(true);
  }

  markOutboundTrack(track: MediaStreamTrack | null): void {
    if (track === this.outputVideoTrack) {
      this.status.cameraRoute = 'outbound';
      this.status.error = null;
      this.status.message = 'Processed camera track is attached to Google Meet.';
      this.emitStatus(true);
      return;
    }
    if (track === this.inputVideoTrack) {
      this.status.cameraRoute = 'original';
      this.status.message = 'Google Meet is using the original camera track.';
      this.emitStatus(true);
      return;
    }
    if (!track && this.outputStream) {
      this.status.cameraRoute = 'processed';
      this.status.message = 'Processed camera track is ready for Google Meet.';
      this.emitStatus(true);
    }
  }

  get currentStatus(): PipelineStatus {
    return { ...this.status, modelReady: this.segmenter.ready, backgroundAvailable: this.backgroundManager.ready };
  }

  private async ensureModel(): Promise<void> {
    if (this.modelInitStarted || this.segmenter.ready) return;
    if (!this.assetBaseUrl) return;
    this.modelInitStarted = true;
    this.status.message = 'Loading the local segmentation model…';
    this.emitStatus(true);
    try {
      const wasmUrl = new URL('wasm/', this.assetBaseUrl).toString();
      const modelUrl = new URL('models/selfie_segmenter.tflite', this.assetBaseUrl).toString();
      await this.segmenter.initialize(wasmUrl, modelUrl);
      this.status.error = null;
      this.status.message = 'Local segmentation is ready.';
      this.emitStatus(true);
    } catch (error) {
      this.status.modelReady = false;
      this.fail(`Segmentation could not start: ${toErrorMessage(error)}. The captured-plate mode remains available.`);
    } finally {
      this.modelInitStarted = false;
    }
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame((timestamp) => {
      try {
        this.renderFrame(timestamp);
      } catch (error) {
        this.latestMask = null;
        this.fail(`Camera processing recovered from a frame error: ${toErrorMessage(error)}`);
      } finally {
        this.scheduleFrame();
      }
    });
  }

  private renderFrame(timestamp: number): void {
    const video = this.video;
    if (!video || !this.outputStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const inputTrack = this.inputVideoTrack;
    const outputTrack = this.outputVideoTrack;
    if (inputTrack?.readyState !== 'live' || outputTrack?.readyState !== 'live') {
      this.stop();
      return;
    }
    if (!inputTrack.enabled) {
      outputTrack.enabled = false;
      if (this.cameraEnabled) {
        this.cameraEnabled = false;
        this.status.cameraAvailable = false;
        this.status.message = 'Google Meet camera is off; microphone audio is preserved.';
        this.emitStatus(true);
      }
      return;
    }
    if (!this.cameraEnabled) {
      this.cameraEnabled = true;
      outputTrack.enabled = true;
      this.status.cameraAvailable = true;
      this.status.message = 'Google Meet camera is live again.';
      this.emitStatus(true);
    }
    if (video.videoWidth !== this.lastWidth || video.videoHeight !== this.lastHeight) {
      this.lastWidth = video.videoWidth;
      this.lastHeight = video.videoHeight;
      this.compositor.resize(video.videoWidth || 640, video.videoHeight || 480);
    }

    if (this.settingsValue.realTimeRemoval && this.segmenter.ready && this.performance.shouldInfer(timestamp)) {
      this.performance.beginInference(timestamp);
      const inferenceStarted = performance.now();
      try {
        this.latestMask = this.segmenter.segment(video, timestamp);
      } catch (error) {
        this.latestMask = null;
        this.status.error = `A segmentation frame was skipped: ${toErrorMessage(error)}`;
      }
      this.performance.recordInference(performance.now() - inferenceStarted);
    }

    const transition = this.disappearance.state;
    const progress = this.disappearance.progress(timestamp);
    const strength = transition === 'disappear' ? progress : transition === 'reappear' ? 1 - progress : this.status.effectActive ? 1 : 0;
    const hiddenOrTransitioning = this.status.effectActive || transition === 'reappear';
    this.compositor.render(video, this.backgroundManager, this.latestMask, {
      hidden: hiddenOrTransitioning,
      transitionStrength: strength,
      realTimeRemoval: this.settingsValue.realTimeRemoval,
      useBackgroundPlate: this.settingsValue.useBackgroundPlate
    });

    if (this.settingsValue.animations) {
      this.particles.render(this.compositor.canvas.getContext('2d')!, timestamp, this.settingsValue.animationIntensity);
    }

    this.performance.recordFrame(timestamp);
    if (this.backgroundManager.ready && timestamp - this.lastMismatchCheck > 1800 && !this.mismatchCheckPending) {
      this.lastMismatchCheck = timestamp;
      this.mismatchCheckPending = true;
      void this.backgroundManager.compareToVideo(video, this.compositor.canvas.width, this.compositor.canvas.height)
        .then((mismatch) => {
          this.status.backgroundMismatch = mismatch;
          this.mismatchCheckPending = false;
          this.emitStatus(true);
        })
        .catch(() => {
          this.mismatchCheckPending = false;
        });
    }
    this.status.modelReady = this.segmenter.ready;
    this.status.backgroundAvailable = this.backgroundManager.ready;
    this.status.usingBackgroundPlate = this.status.effectActive && this.settingsValue.useBackgroundPlate && this.backgroundManager.ready;
    this.status.fps = this.performance.getFps();
    this.status.inferenceMs = this.performance.getInferenceMs();
    this.status.message = this.status.effectActive ? this.hiddenMessage() : this.status.message;
    if (timestamp - this.lastStatusSent > 450) this.emitStatus();
  }

  private hiddenMessage(): string {
    if (!this.settingsValue.useBackgroundPlate || !this.backgroundManager.ready) {
      return 'No clean plate is available; live pixels are softened instead of reconstructed.';
    }
    if (this.status.backgroundMismatch) return 'Background mismatch detected — recapture for a cleaner effect.';
    if (this.settingsValue.realTimeRemoval && !this.segmenter.ready) return 'Waiting for segmentation; the captured plate is being used safely.';
    if (this.settingsValue.realTimeRemoval && !this.latestMask) return 'Waiting for a valid person mask; the captured plate is being used safely.';
    return 'Disappeared locally. Press the shortcut again to reappear.';
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

function getConstraintNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const candidate = value as { ideal?: unknown; max?: unknown; min?: unknown };
    for (const nested of [candidate.ideal, candidate.max, candidate.min]) {
      if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
    }
  }
  return fallback;
}

async function waitForVideo(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  try {
    await video.play();
  } catch {
    // A muted video should normally autoplay; metadata and current frames may still arrive.
  }
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener('loadedmetadata', finish);
      resolve();
    };
    video.addEventListener('loadedmetadata', finish, { once: true });
    window.setTimeout(finish, timeoutMs);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
