import { describeSiteUrl } from '../shared/sites';
import { isBackgroundPlate } from '../shared/background-plate';
import { CONTENT_SOURCE, isPageMessage } from '../shared/messages';
import { DEFAULT_SETTINGS, DEFAULT_STATUS, type ContentMessage, type ExtensionSnapshot, type FrameConfig, type PipelineStatus } from '../shared/types';

const site = describeSiteUrl(location);
const sessionId = crypto.randomUUID();
let config: FrameConfig | null = null;
let pageReady = false;
let latestStatus: PipelineStatus = { ...DEFAULT_STATUS, siteDetected: site !== null };
let configRevision = 0;
let backgroundSave: Promise<unknown> = Promise.resolve();
const pending = new Map<string, { resolve: (value: { ok: boolean; error?: string }) => void; timer: number }>();

if (site && window === window.top) {
  window.addEventListener('message', onPageMessage);
  window.addEventListener('pageshow', (event) => { if (event.persisted) void refreshConfiguration(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.globalEnabled || changes.siteProfiles)) void refreshConfiguration();
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return false;
    if (message.type === 'POLICY_CHANGED') {
      if (message.siteKey && message.siteKey !== site.siteKey) return false;
      void refreshConfiguration().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (!['GET_STATUS', 'TOGGLE_EFFECT', 'CAPTURE_BACKGROUND', 'DELETE_BACKGROUND', 'SET_SETTINGS', 'DEACTIVATE'].includes(message.type)) return false;
    void runtimeCommand(message).then(sendResponse, (error) => sendResponse({ ok: false, error: toErrorMessage(error) }));
    return true;
  });
  // Registration occurs before navigation; retry the page-world handshake if
  // MAIN/isolated scheduling delivers READY before this listener exists.
  for (const delay of [0, 150, 600, 1600]) window.setTimeout(() => post('PING'), delay);
  void refreshConfiguration();
  // Also fails closed after extension invalidation or permission revocation.
  window.setInterval(() => void refreshConfiguration(), 8000);
}

async function refreshConfiguration(): Promise<void> {
  const epoch = ++configRevision;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_FRAME_CONFIG' });
    if (epoch !== configRevision) return;
    if (!response?.ok || !response.config || response.config.site?.siteKey !== site?.siteKey) {
      throw new Error(response?.error ?? 'Veyl could not verify this website’s access.');
    }
    const previous = config;
    config = response.config as FrameConfig;
    if (!previous || JSON.stringify(previous) !== JSON.stringify(config) || !latestStatus.bridgeReady) sendConfiguration();
    else if (config.enabled) post('HEARTBEAT');
  } catch (error) {
    if (epoch !== configRevision) return;
    config = null;
    latestStatus = { ...DEFAULT_STATUS, siteDetected: true, siteKey: site?.siteKey ?? null,
      message: 'Veyl is disabled until site access can be verified.', error: toErrorMessage(error) };
    post('DEACTIVATE');
  }
}

function sendConfiguration(): void {
  if (!pageReady || !site || !config) return;
  post('CONFIG', {
    siteKey: site.siteKey, siteLabel: site.label, sessionId,
    settings: config.profile?.settings ?? DEFAULT_SETTINGS,
    background: config.profile?.background ?? null,
    assetBaseUrl: chrome.runtime.getURL(''),
    siteEnabled: config.enabled,
    hostPermissionGranted: config.hostPermissionGranted
  });
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== location.origin || !isPageMessage(event.data)) return;
  const message = event.data;
  if (message.type === 'READY') {
    pageReady = true;
    sendConfiguration();
    return;
  }
  if (message.sessionId !== sessionId) return;
  if (message.type === 'COMMAND_RESULT' && message.requestId) {
    const waiting = pending.get(message.requestId);
    if (waiting) {
      window.clearTimeout(waiting.timer);
      pending.delete(message.requestId);
      waiting.resolve(message.payload as { ok: boolean; error?: string });
    }
  } else if (message.type === 'STATUS' && isStatus(message.payload)) {
    latestStatus = { ...message.payload, siteKey: site?.siteKey ?? null, siteLabel: site?.label ?? '',
      siteDetected: true, siteEnabled: config?.enabled === true, hostPermissionGranted: config?.hostPermissionGranted === true };
  } else if (message.type === 'BACKGROUND_CAPTURED' && config?.enabled && isBackgroundPlate(message.payload)) {
    backgroundSave = chrome.runtime.sendMessage({ type: 'FRAME_BACKGROUND_CAPTURED', background: message.payload }).then((response) => {
      if (!response?.ok) throw new Error(response?.error ?? 'The background could not be saved locally.');
    });
    void backgroundSave.catch(showStorageError);
  } else if (message.type === 'BACKGROUND_DELETED' && config?.enabled) {
    backgroundSave = chrome.runtime.sendMessage({ type: 'FRAME_BACKGROUND_DELETED' }).then((response) => {
      if (!response?.ok) throw new Error(response?.error ?? 'The background could not be deleted locally.');
    });
    void backgroundSave.catch(showStorageError);
  } else if (message.type === 'ERROR') {
    latestStatus.error = String(message.payload ?? 'Veyl could not complete the camera operation.').slice(0, 1200);
  }
}

async function runtimeCommand(message: ContentMessage & { fromShortcut?: boolean }): Promise<unknown> {
  if (message.type === 'GET_STATUS') {
    const snapshot: ExtensionSnapshot = { globalEnabled: config?.globalEnabled ?? false, site,
      settings: config?.profile?.settings ?? DEFAULT_SETTINGS, background: config?.profile?.background ?? null, status: latestStatus };
    return { ok: true, snapshot };
  }
  if (message.type === 'DEACTIVATE') return pageCommand('DEACTIVATE');
  // Browser commands may fire while typing; the page-key listener does the same check.
  if (message.fromShortcut && isEditing()) return { ok: false, error: 'Keyboard toggle ignored while typing.' };
  await refreshConfiguration();
  if (!config?.enabled) return { ok: false, error: 'Enable Veyl on this website first.' };
  const response = await pageCommand(message.type, message.settings);
  if (response.ok && (message.type === 'CAPTURE_BACKGROUND' || message.type === 'DELETE_BACKGROUND')) await backgroundSave;
  return response;
}

function pageCommand(type: string, payload?: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!pageReady) return Promise.resolve({ ok: false, error: 'Reload this website to connect Veyl before its camera starts.' });
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'The camera page did not respond. Reload it and try again.' }); }, 5000);
    pending.set(requestId, { resolve, timer });
    post(type, payload, requestId);
  });
}

function post(type: string, payload?: unknown, requestId?: string): void {
  window.postMessage({ source: CONTENT_SOURCE, type, sessionId, payload, requestId }, location.origin);
}

function isStatus(value: unknown): value is PipelineStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as PipelineStatus;
  return ['waiting', 'original', 'processed', 'outbound'].includes(status.cameraRoute)
    && typeof status.message === 'string' && typeof status.cameraAvailable === 'boolean'
    && typeof status.pipelineInitialized === 'boolean' && typeof status.effectActive === 'boolean';
}

function isEditing(): boolean {
  const target = document.activeElement as HTMLElement | null;
  return Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? ''));
}
function showStorageError(error: unknown): void { latestStatus.error = toErrorMessage(error); }
function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
