import { CameraPipeline, PipelineEvent } from '../camera/camera-pipeline';
import { GestureController } from '../gestures/gesture-controller';
import { SnapDetector } from '../gestures/snap-detector';
import { sanitizeSettings } from '../shared/settings';
import { DEFAULT_SETTINGS, DEFAULT_STATUS, PageInitPayload, PipelineStatus, SnapSettings } from '../shared/types';
import { CONTENT_SOURCE, PAGE_SOURCE, isContentMessage } from '../shared/messages';

declare global {
  interface Window {
    __veylPageBridgeInstalled?: boolean;
  }
}

if (!window.__veylPageBridgeInstalled) {
  window.__veylPageBridgeInstalled = true;
  installPageBridge();
}

function installPageBridge(): void {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    post('ERROR', 'This page does not expose a camera API.');
    return;
  }

  let settings: SnapSettings = { ...DEFAULT_SETTINGS };
  let snapActive = false;
  let currentStatus: PipelineStatus = { ...DEFAULT_STATUS };
  const snapDetector = new SnapDetector();
  const pipeline = new CameraPipeline(settings, (event) => handlePipelineEvent(event));
  const gestureController = new GestureController(() => pipeline.toggleEffect());
  const detachKeyboard = gestureController.attach();
  const originalGetUserMediaValue = mediaDevices.getUserMedia;
  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const restoreWebRtcHooks = installWebRtcRoutingHooks(pipeline);

  const wrappedGetUserMedia = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    const stream = await originalGetUserMedia(constraints);
    if (!constraints?.video) return stream;
    if (stream.getVideoTracks().length === 0) return stream;
    try {
      return await pipeline.attach(stream, constraints.video === true ? undefined : constraints.video);
    } catch (error) {
      pipeline.markOriginalFallback();
      post('ERROR', `Snap could not route this camera stream: ${toErrorMessage(error)}`);
      return stream;
    }
  };

  let mediaHookInstalled = false;
  try {
    mediaDevices.getUserMedia = wrappedGetUserMedia;
    mediaHookInstalled = true;
  } catch {
    try {
      Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: wrappedGetUserMedia });
      mediaHookInstalled = true;
    } catch (error) {
      restoreWebRtcHooks();
      detachKeyboard();
      post('ERROR', `Veyl could not install the Meet camera hook: ${toErrorMessage(error)}`);
      return;
    }
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || !isContentMessage(event.data)) return;
    void handleContentMessage(event.data.type, event.data.payload).catch((error) => {
      post('ERROR', toErrorMessage(error));
    });
  });

  window.addEventListener('pagehide', () => {
    detachKeyboard();
    void snapDetector.stop();
    pipeline.dispose();
    restoreWebRtcHooks();
    if (mediaHookInstalled) {
      try {
        mediaDevices.getUserMedia = originalGetUserMediaValue;
      } catch {
        // The document is going away; there is no remaining page API to repair.
      }
    }
    window.__veylPageBridgeInstalled = false;
  }, { once: true });

  window.addEventListener('pageshow', () => {
    if (!window.__veylPageBridgeInstalled) {
      window.__veylPageBridgeInstalled = true;
      installPageBridge();
    }
  }, { once: true });

  post('READY');

  async function handleContentMessage(type: string, payload: unknown): Promise<void> {
    switch (type) {
      case 'INIT': {
        const init = payload as PageInitPayload;
        settings = sanitizeSettings(init.settings);
        await pipeline.setSettings(settings);
        await pipeline.setAssetBaseUrl(init.assetBaseUrl);
        await pipeline.setBackground(init.background);
        await updateSnapDetector();
        emitStatus();
        break;
      }
      case 'SET_SETTINGS':
        const previousSnapSensitivity = settings.snapSensitivity;
        settings = sanitizeSettings({ ...settings, ...(payload as Partial<SnapSettings>) });
        await pipeline.setSettings(settings);
        if (snapDetector.active && settings.snapSensitivity !== previousSnapSensitivity) {
          snapDetector.setSensitivity(settings.snapSensitivity);
        }
        await updateSnapDetector();
        emitStatus();
        break;
      case 'TOGGLE_EFFECT':
        pipeline.toggleEffect();
        break;
      case 'CAPTURE_BACKGROUND':
        try {
          await pipeline.captureBackground();
        } catch (error) {
          post('ERROR', toErrorMessage(error));
        }
        break;
      case 'DELETE_BACKGROUND':
        await pipeline.deleteBackground();
        break;
      case 'PING':
        post('READY');
        emitStatus();
        break;
      default:
        break;
    }
  }

  async function updateSnapDetector(): Promise<void> {
    if (!settings.snapDetection) {
      await snapDetector.stop();
      snapActive = false;
      return;
    }
    if (snapDetector.active) return;
    try {
      await snapDetector.start(settings.snapSensitivity, () => pipeline.toggleEffect());
      snapActive = true;
    } catch (error) {
      snapActive = false;
      post('ERROR', `Snap detection needs microphone permission: ${toErrorMessage(error)}`);
    }
  }

  function handlePipelineEvent(event: PipelineEvent): void {
    if (event.type === 'STATUS') {
      currentStatus = { ...event.status, snapDetectionActive: snapActive };
      emitStatus();
    } else if (event.type === 'BACKGROUND_CAPTURED') {
      post('BACKGROUND_CAPTURED', event.background);
      emitStatus();
    } else if (event.type === 'BACKGROUND_DELETED') {
      post('BACKGROUND_DELETED');
      emitStatus();
    } else if (event.type === 'ERROR') {
      post('ERROR', event.error);
      emitStatus();
    }
  }

  function emitStatus(): void {
    currentStatus = { ...pipeline.currentStatus, snapDetectionActive: snapActive };
    post('STATUS', currentStatus);
  }
}

function post(type: 'READY' | 'STATUS' | 'BACKGROUND_CAPTURED' | 'BACKGROUND_DELETED' | 'ERROR', payload?: unknown): void {
  const message = { source: PAGE_SOURCE, type, payload };
  window.postMessage(message, '*');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function installWebRtcRoutingHooks(pipeline: CameraPipeline): () => void {
  const restore: Array<() => void> = [];
  const peerConnectionPrototype = window.RTCPeerConnection?.prototype;

  if (peerConnectionPrototype) {
    const originalAddTrack = peerConnectionPrototype.addTrack;
    const wrappedAddTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender {
      const routedTrack = pipeline.routeVideoTrack(track);
      const sender = originalAddTrack.call(this, routedTrack, ...streams);
      if (routedTrack.kind === 'video') pipeline.markOutboundTrack(routedTrack);
      return sender;
    } as typeof originalAddTrack;

    try {
      peerConnectionPrototype.addTrack = wrappedAddTrack;
      restore.push(() => {
        peerConnectionPrototype.addTrack = originalAddTrack;
      });
    } catch {
      // Some browser builds expose a non-writable WebRTC prototype method.
    }

    const originalAddTransceiver = peerConnectionPrototype.addTransceiver;
    const wrappedAddTransceiver = function (
      this: RTCPeerConnection,
      trackOrKind: MediaStreamTrack | string,
      init?: RTCRtpTransceiverInit
    ): RTCRtpTransceiver {
      const routedTrack = typeof trackOrKind === 'string' ? trackOrKind : pipeline.routeVideoTrack(trackOrKind);
      const transceiver = originalAddTransceiver.call(this, routedTrack as never, init);
      if (typeof routedTrack !== 'string' && routedTrack.kind === 'video') pipeline.markOutboundTrack(routedTrack);
      return transceiver;
    } as typeof originalAddTransceiver;

    try {
      peerConnectionPrototype.addTransceiver = wrappedAddTransceiver;
      restore.push(() => {
        peerConnectionPrototype.addTransceiver = originalAddTransceiver;
      });
    } catch {
      // Keep the getUserMedia replacement as the primary integration path.
    }

    const originalRemoveTrack = peerConnectionPrototype.removeTrack;
    const wrappedRemoveTrack = function (this: RTCPeerConnection, sender: RTCRtpSender): void {
      const wasVideo = sender.track?.kind === 'video';
      originalRemoveTrack.call(this, sender);
      if (wasVideo) pipeline.markOutboundTrack(null);
    } as typeof originalRemoveTrack;

    try {
      peerConnectionPrototype.removeTrack = wrappedRemoveTrack;
      restore.push(() => {
        peerConnectionPrototype.removeTrack = originalRemoveTrack;
      });
    } catch {
      // Removing a sender is not required for the primary path.
    }
  }

  const pageWindow = window as typeof window & { RTCRtpSender?: typeof RTCRtpSender };
  const senderPrototype = pageWindow.RTCRtpSender?.prototype;
  if (senderPrototype) {
    const originalReplaceTrack = senderPrototype.replaceTrack;
    const wrappedReplaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
      const routedTrack = track ? pipeline.routeVideoTrack(track) : null;
      const result = originalReplaceTrack.call(this, routedTrack);
      if (routedTrack?.kind === 'video' || this.track?.kind === 'video') {
        void result.then(() => pipeline.markOutboundTrack(routedTrack)).catch(() => undefined);
      }
      return result;
    } as typeof originalReplaceTrack;

    try {
      senderPrototype.replaceTrack = wrappedReplaceTrack;
      restore.push(() => {
        senderPrototype.replaceTrack = originalReplaceTrack;
      });
    } catch {
      // The returned processed stream remains the fallback integration path.
    }
  }

  return () => {
    for (const undo of restore.reverse()) {
      try {
        undo();
      } catch {
        // The document is already being torn down.
      }
    }
  };
}

void CONTENT_SOURCE;
