import { sanitizeSettings } from '../shared/settings';
import { CONTENT_SOURCE, PAGE_SOURCE, isPageMessage } from '../shared/messages';
import { BackgroundPlate, ContentMessage, DEFAULT_SETTINGS, DEFAULT_STATUS, ExtensionSnapshot, PipelineStatus, SnapSettings } from '../shared/types';

const isMeetPage = location.hostname === 'meet.google.com';
let pageReady = false;
let latestStatus: PipelineStatus = { ...DEFAULT_STATUS, siteDetected: isMeetPage };
let settings: SnapSettings = { ...DEFAULT_SETTINGS };
let background: BackgroundPlate | null = null;
let stateLoaded = false;
let bridgePingAttempts = 0;

if (isMeetPage) {
  window.addEventListener('message', onPageMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  void loadStoredState()
    .catch((error) => {
      latestStatus.error = `Veyl could not load its local settings: ${toErrorMessage(error)}`;
      latestStatus.message = 'Using safe default settings.';
      notifyStatus();
    })
    .finally(() => {
      stateLoaded = true;
      requestPageBridge();
    });
}

async function loadStoredState(): Promise<void> {
  const stored = await chrome.storage.local.get(['settings', 'background']);
  settings = sanitizeSettings(stored.settings as Partial<SnapSettings> | undefined);
  background = isBackgroundPlate(stored.background) ? stored.background : null;
}

function requestPageBridge(): void {
  if (pageReady) {
    initializePageBridge();
    return;
  }

  bridgePingAttempts += 1;
  window.postMessage({ source: CONTENT_SOURCE, type: 'PING' }, '*');
  if (bridgePingAttempts < 12) {
    window.setTimeout(requestPageBridge, 150);
    return;
  }

  latestStatus.error = 'Veyl could not initialize its Meet page bridge.';
  latestStatus.message = 'Reload the Meet tab and try again.';
  notifyStatus();
}

function initializePageBridge(): void {
  if (!stateLoaded || !pageReady) return;
  postToPage('INIT', { settings, background, assetBaseUrl: chrome.runtime.getURL('') });
}

function onPageMessage(event: MessageEvent): void {
  if (event.source !== window || !isPageMessage(event.data)) return;
  const type = event.data.type;
  if (type === 'READY') {
    pageReady = true;
    initializePageBridge();
  } else if (type === 'STATUS') {
    latestStatus = { ...(event.data.payload as PipelineStatus), siteDetected: true };
    notifyStatus();
  } else if (type === 'BACKGROUND_CAPTURED') {
    const captured = event.data.payload as BackgroundPlate;
    if (!isBackgroundPlate(captured)) return;
    background = captured;
    void chrome.storage.local.set({ background }).catch((error) => {
      latestStatus.error = `The background was captured but could not be saved locally: ${toErrorMessage(error)}`;
      latestStatus.message = 'Recapture or delete the background after checking extension storage.';
      notifyStatus();
    });
    latestStatus.backgroundAvailable = true;
    latestStatus.backgroundMismatch = false;
    notifyStatus();
  } else if (type === 'BACKGROUND_DELETED') {
    background = null;
    void chrome.storage.local.remove('background').catch((error) => {
      latestStatus.error = `The background preview was cleared but local deletion failed: ${toErrorMessage(error)}`;
      notifyStatus();
    });
    latestStatus.backgroundAvailable = false;
    notifyStatus();
  } else if (type === 'ERROR') {
    latestStatus.error = String(event.data.payload ?? 'Unknown Snap error');
    latestStatus.message = latestStatus.error;
    notifyStatus();
  }
}

function onStorageChanged(changes: { [key: string]: chrome.storage.StorageChange }): void {
  if (changes.settings?.newValue) {
    settings = sanitizeSettings(changes.settings.newValue as Partial<SnapSettings>);
    postToPage('SET_SETTINGS', settings);
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'background')) {
    background = isBackgroundPlate(changes.background.newValue) ? changes.background.newValue : null;
    initializePageBridge();
  }
}

function onRuntimeMessage(message: ContentMessage | { type: 'TOGGLE_EFFECT' }, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): true {
  void handleRuntimeMessage(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
}

async function handleRuntimeMessage(message: ContentMessage | { type: 'TOGGLE_EFFECT' }): Promise<unknown> {
  if (message.type === 'GET_STATUS') {
    const snapshot: ExtensionSnapshot = { settings, background, status: latestStatus };
    return { ok: true, snapshot };
  }
  if (message.type === 'TOGGLE_EFFECT') {
    postToPage('TOGGLE_EFFECT');
    return { ok: pageReady };
  }
  if (message.type === 'CAPTURE_BACKGROUND') {
    postToPage('CAPTURE_BACKGROUND');
    return { ok: pageReady };
  }
  if (message.type === 'DELETE_BACKGROUND') {
    background = null;
    await chrome.storage.local.remove('background');
    postToPage('DELETE_BACKGROUND');
    return { ok: pageReady };
  }
  if (message.type === 'SET_SETTINGS' && message.settings) {
    settings = sanitizeSettings(message.settings);
    await chrome.storage.local.set({ settings });
    postToPage('SET_SETTINGS', settings);
    return { ok: pageReady };
  }
  return { ok: false, error: 'Unknown message.' };
}

function postToPage(type: string, payload?: unknown): void {
  if (!pageReady) return;
  window.postMessage({ source: CONTENT_SOURCE, type, payload }, '*');
}

function notifyStatus(): void {
  // Popup instances ask for the latest state; this message is also useful to a future
  // side panel without exposing any camera data to the extension worker.
  void chrome.runtime.sendMessage({ type: 'STATUS_UPDATED', status: latestStatus }).catch(() => undefined);
}

function isBackgroundPlate(value: unknown): value is BackgroundPlate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BackgroundPlate>;
  return Boolean(
    typeof candidate.dataUrl === 'string' &&
      candidate.dataUrl.startsWith('data:image/') &&
      typeof candidate.width === 'number' &&
      Number.isFinite(candidate.width) &&
      candidate.width > 0 &&
      typeof candidate.height === 'number' &&
      Number.isFinite(candidate.height) &&
      candidate.height > 0
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
