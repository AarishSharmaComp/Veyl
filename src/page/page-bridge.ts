import { CameraPipeline, type PipelineEvent } from '../camera/camera-pipeline';
import { installCameraIntegration, type CameraIntegration } from '../integration/camera-integration';
import { GestureController } from '../gestures/gesture-controller';
import { sanitizeSettings } from '../shared/settings';
import { describeSiteUrl } from '../shared/sites';
import { isBackgroundPlate } from '../shared/background-plate';
import { DEFAULT_SETTINGS, DEFAULT_STATUS, type PageInitPayload, type PipelineStatus } from '../shared/types';
import { PAGE_SOURCE, isContentMessage, type BridgeMessage } from '../shared/messages';

declare global { interface Window { __veylPageBridgeInstalled?: boolean } }

if (!window.__veylPageBridgeInstalled && describeSiteUrl(location)) {
  window.__veylPageBridgeInstalled = true;
  installPageBridge();
}

/** Minimal synchronous prehook captures native APIs before the page caches them.
 * No camera, microphone or ML task is started until the worker-authorized isolated
 * content script enables this exact origin. Pending native video requests wait
 * at most 1500 ms for that decision and otherwise return the original stream. */
function installPageBridge(): void {
  const site = describeSiteUrl(location)!;
  let authorized = false;
  let permissionGranted = false;
  let sessionId = '';
  let configured = false;
  let leaseExpiresAt = 0;
  let policyMessage = 'Waiting for Veyl site authorization…';
  let policyError: string | null = null;
  let revision = 0;
  let detachKeyboard: (() => void) | null = null;
  let integration: CameraIntegration | null = null;
  let resolveInitial: () => void = () => undefined;
  const initialPolicy = new Promise<void>((resolve) => { resolveInitial = resolve; });
  const pipeline = new CameraPipeline(DEFAULT_SETTINGS, handlePipelineEvent);

  function prehook(): CameraIntegration {
    return installCameraIntegration(pipeline, {
      active: () => authorized,
      authorize: async () => { await initialPolicy; return authorized; },
      onError: (error) => { policyError = toErrorMessage(error); emitStatus(); }
    });
  }
  // Keep the selected site's early native acquisition safe, including Meet.
  integration = prehook();

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin || !isContentMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'PING') { post('READY'); return; }
    if (message.type === 'CONFIG') {
      void configure(message).catch((error) => {
        policyError = toErrorMessage(error);
        authorized = false;
        void deactivate('Veyl configuration failed. Reload this website.');
      });
      return;
    }
    if (!sessionId || message.sessionId !== sessionId) return;
    if (message.type === 'HEARTBEAT') { leaseExpiresAt = Date.now() + 25_000; return; }
    void handleCommand(message).then((result) => {
      if (message.requestId) post('COMMAND_RESULT', result, message.requestId);
    }, (error) => {
      const detail = toErrorMessage(error);
      post('ERROR', detail);
      if (message.requestId) post('COMMAND_RESULT', { ok: false, error: detail }, message.requestId);
    });
  });

  async function configure(message: BridgeMessage): Promise<void> {
    const init = message.payload as PageInitPayload;
    if (!validConfiguration(init, message.sessionId, site.siteKey)) throw new Error('Veyl rejected an invalid site configuration.');
    const epoch = ++revision;
    sessionId = init.sessionId;
    configured = true;
    permissionGranted = init.hostPermissionGranted;
    leaseExpiresAt = Date.now() + 25_000;
    authorized = init.siteEnabled && permissionGranted;
    resolveInitial();
    if (!authorized) {
      await deactivate(init.siteEnabled ? 'Site permission is missing. Re-enable Veyl from its popup.' : 'Veyl is disabled on this website.');
      return;
    }
    policyError = null;
    policyMessage = '';
    if (!integration || integration.currentState.disposed) integration = prehook();
    await integration.setActive(true);
    if (epoch !== revision || !authorized) return;
    pipeline.setSiteContext(site, true, true, true);
    if (!detachKeyboard) detachKeyboard = new GestureController(() => pipeline.toggleEffect()).attach();
    // Background/settings are installed independently; a slow model load must
    // not delay disabling or a safe captured-plate mode.
    await pipeline.setBackground(init.background);
    if (epoch !== revision || !authorized) return;
    await Promise.all([pipeline.setSettings(sanitizeSettings(init.settings)), pipeline.setAssetBaseUrl(init.assetBaseUrl)]);
    if (epoch === revision) emitStatus();
  }

  async function deactivate(reason: string): Promise<void> {
    authorized = false;
    revision += 1;
    policyMessage = reason;
    detachKeyboard?.();
    detachKeyboard = null;
    const current = integration;
    if (current) await current.dispose();
    emitStatus();
  }

  async function handleCommand(message: BridgeMessage): Promise<{ ok: boolean }> {
    if (message.type === 'DEACTIVATE') {
      await deactivate('Veyl is disabled on this website.');
      return { ok: true };
    }
    if (!authorized) throw new Error('Enable Veyl on this website first.');
    switch (message.type) {
      case 'SET_SETTINGS': await pipeline.setSettings(sanitizeSettings(message.payload as typeof DEFAULT_SETTINGS)); break;
      case 'TOGGLE_EFFECT': {
        const status = pipeline.currentStatus;
        if (!status.cameraAvailable || !status.pipelineInitialized) throw new Error('Turn on the website camera before using Veyl.');
        pipeline.toggleEffect();
        break;
      }
      case 'CAPTURE_BACKGROUND': await pipeline.captureBackground(); break;
      case 'DELETE_BACKGROUND': await pipeline.deleteBackground(); break;
      default: throw new Error('Unknown Veyl command.');
    }
    emitStatus();
    return { ok: true };
  }

  function handlePipelineEvent(event: PipelineEvent): void {
    if (event.type === 'BACKGROUND_CAPTURED') post(event.type, event.background);
    else if (event.type === 'BACKGROUND_DELETED' || event.type === 'GESTURE_DETECTED') post(event.type);
    else if (event.type === 'ERROR') post('ERROR', event.error);
    emitStatus();
  }

  function emitStatus(): void {
    const status: PipelineStatus = { ...DEFAULT_STATUS, ...pipeline.currentStatus,
      siteKey: site.siteKey, siteLabel: site.label, siteDetected: true,
      siteEnabled: authorized, hostPermissionGranted: permissionGranted, bridgeReady: configured };
    if (!authorized) {
      status.effectActive = false;
      status.gestureDetectionActive = false;
      status.handTracked = false;
      if (!status.reloadRequired) status.message = policyMessage;
    }
    if (policyError) status.error = policyError;
    post('STATUS', status);
  }

  function post(type: string, payload?: unknown, requestId?: string): void {
    window.postMessage({ source: PAGE_SOURCE, type, payload, sessionId, requestId }, location.origin);
  }

  // If the extension is disabled/uninstalled, existing MAIN-world scripts are
  // not removed by Chrome. A bounded lease restores observed native senders and
  // releases models instead of leaving a detached processing loop indefinitely.
  window.setInterval(() => {
    if (authorized && Date.now() > leaseExpiresAt) void deactivate('Veyl was disconnected. Reload the page after enabling the extension.');
  }, 5000);
  window.addEventListener('pagehide', () => { void deactivate('Veyl paused for page navigation.'); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) post('READY'); });
  post('READY');
}

function validConfiguration(value: unknown, sessionId: string | undefined, siteKey: string): value is PageInitPayload {
  if (!value || typeof value !== 'object') return false;
  const init = value as Partial<PageInitPayload>;
  return init.siteKey === siteKey && typeof sessionId === 'string' && sessionId.length >= 8
    && init.sessionId === sessionId && typeof init.siteLabel === 'string'
    && typeof init.siteEnabled === 'boolean' && typeof init.hostPermissionGranted === 'boolean'
    && !!init.settings && typeof init.settings === 'object'
    && typeof init.assetBaseUrl === 'string' && /^chrome-extension:\/\/[a-p]{32}\/$/.test(init.assetBaseUrl)
    && (init.background === null || isBackgroundPlate(init.background));
}

function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
