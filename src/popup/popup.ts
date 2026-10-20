import { sanitizeSettings } from '../shared/settings';
import { BackgroundPlate, DEFAULT_SETTINGS, DEFAULT_STATUS, ExtensionSnapshot, PipelineStatus, SnapSettings } from '../shared/types';

interface ActiveMeetTab {
  id: number;
  url?: string;
}

let activeTab: ActiveMeetTab | null = null;
let settings: SnapSettings = { ...DEFAULT_SETTINGS };
let background: BackgroundPlate | null = null;
let status: PipelineStatus = { ...DEFAULT_STATUS, siteDetected: false, message: 'Open Google Meet to use Snap.' };
let toastTimer = 0;

const elements = {
  headerStatus: get<HTMLElement>('header-status'),
  heroTitle: get<HTMLElement>('hero-title'),
  heroSubtitle: get<HTMLElement>('hero-subtitle'),
  toggleEffect: get<HTMLButtonElement>('toggle-effect'),
  toggleLabel: get<HTMLElement>('toggle-label'),
  meetStatus: get<HTMLElement>('meet-status'),
  cameraStatus: get<HTMLElement>('camera-status'),
  modelStatus: get<HTMLElement>('model-status'),
  effectStatus: get<HTMLElement>('effect-status'),
  statusMessage: get<HTMLElement>('status-message'),
  processingPill: get<HTMLElement>('processing-pill'),
  meetIcon: get<HTMLElement>('meet-icon'),
  cameraIcon: get<HTMLElement>('camera-icon'),
  modelIcon: get<HTMLElement>('model-icon'),
  effectIcon: get<HTMLElement>('effect-icon'),
  backgroundBadge: get<HTMLElement>('background-badge'),
  backgroundPreview: get<HTMLElement>('background-preview'),
  backgroundImage: get<HTMLImageElement>('background-image'),
  captureBackground: get<HTMLButtonElement>('capture-background'),
  deleteBackground: get<HTMLButtonElement>('delete-background'),
  realtimeToggle: get<HTMLInputElement>('realtime-toggle'),
  plateToggle: get<HTMLInputElement>('plate-toggle'),
  animationToggle: get<HTMLInputElement>('animation-toggle'),
  intensitySlider: get<HTMLInputElement>('intensity-slider'),
  intensityValue: get<HTMLOutputElement>('intensity-value'),
  performanceSelect: get<HTMLSelectElement>('performance-select'),
  snapToggle: get<HTMLInputElement>('snap-toggle'),
  sensitivitySlider: get<HTMLInputElement>('sensitivity-slider'),
  sensitivityValue: get<HTMLOutputElement>('sensitivity-value'),
  toast: get<HTMLElement>('toast')
};

void initialize().catch((error) => {
  status = { ...DEFAULT_STATUS, siteDetected: false, message: `Popup could not load local state: ${toErrorMessage(error)}` };
  render();
});

async function initialize(): Promise<void> {
  const stored = await chrome.storage.local.get(['settings', 'background']);
  settings = sanitizeSettings(stored.settings as Partial<SnapSettings> | undefined);
  background = isBackgroundPlate(stored.background) ? stored.background : null;
  bindControls();
  await refreshActiveTab();
  render();
  window.setInterval(() => void refreshActiveTab().catch(() => undefined), 1200);
}

function bindControls(): void {
  elements.toggleEffect.addEventListener('click', () => void sendToContent({ type: 'TOGGLE_EFFECT' }));
  elements.captureBackground.addEventListener('click', async () => {
    const response = await sendToContent({ type: 'CAPTURE_BACKGROUND' });
    if (response?.ok) showToast('Move out of frame and capture the empty scene.');
  });
  elements.deleteBackground.addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove('background');
      const response = await sendToContent({ type: 'DELETE_BACKGROUND' });
      background = null;
      render();
      showToast(response?.ok === false ? 'Background deleted locally; Meet will sync when ready.' : 'Background plate deleted.');
    } catch (error) {
      showToast(`Background could not be deleted: ${toErrorMessage(error)}`);
    }
  });

  elements.realtimeToggle.addEventListener('change', () => void updateSetting({ realTimeRemoval: elements.realtimeToggle.checked }));
  elements.plateToggle.addEventListener('change', () => void updateSetting({ useBackgroundPlate: elements.plateToggle.checked }));
  elements.animationToggle.addEventListener('change', () => void updateSetting({ animations: elements.animationToggle.checked }));
  elements.intensitySlider.addEventListener('input', () => {
    const animationIntensity = Number(elements.intensitySlider.value) / 100;
    elements.intensityValue.value = `${Math.round(animationIntensity * 100)}%`;
    void updateSetting({ animationIntensity });
  });
  elements.performanceSelect.addEventListener('change', () => void updateSetting({ performanceMode: elements.performanceSelect.value as SnapSettings['performanceMode'] }));
  elements.snapToggle.addEventListener('change', async () => {
    await updateSetting({ snapDetection: elements.snapToggle.checked });
    if (elements.snapToggle.checked) showToast('Allow microphone access when Chrome asks. Audio is analyzed locally and not recorded.');
  });
  elements.sensitivitySlider.addEventListener('input', () => {
    const snapSensitivity = Number(elements.sensitivitySlider.value) / 100;
    elements.sensitivityValue.value = `${Math.round(snapSensitivity * 100)}%`;
    void updateSetting({ snapSensitivity });
  });
}

async function refreshActiveTab(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const candidate = tabs[0];
  const isMeet = Boolean(candidate?.id && candidate.url?.startsWith('https://meet.google.com/'));
  activeTab = isMeet && candidate?.id ? { id: candidate.id, url: candidate.url } : null;

  if (!activeTab) {
    status = { ...DEFAULT_STATUS, siteDetected: false, message: 'Open Google Meet to use Snap.' };
    render();
    return;
  }

  const response = await sendToContent({ type: 'GET_STATUS' });
  if (response?.ok && response.snapshot) {
    const snapshot = response.snapshot as ExtensionSnapshot;
    settings = sanitizeSettings(snapshot.settings);
    background = snapshot.background;
    status = { ...snapshot.status, siteDetected: true };
  } else {
    status = { ...DEFAULT_STATUS, siteDetected: true, message: 'Preparing the Meet camera bridge…' };
  }
  render();
}

async function updateSetting(partial: Partial<SnapSettings>): Promise<void> {
  settings = sanitizeSettings({ ...settings, ...partial });
  render();
  try {
    await chrome.storage.local.set({ settings });
  } catch (error) {
    showToast(`Settings could not be saved: ${toErrorMessage(error)}`);
    return;
  }
  const response = await sendToContent({ type: 'SET_SETTINGS', settings });
  if (!response?.ok && activeTab) showToast('Meet is not ready. Reload the Meet tab and try again.');
}

async function sendToContent(message: { type: string; settings?: SnapSettings }): Promise<{ ok?: boolean; snapshot?: ExtensionSnapshot; error?: string } | null> {
  if (!activeTab) return null;
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    return null;
  }
}

function render(): void {
  const meetReady = Boolean(activeTab && status.siteDetected);
  const cameraReady = status.cameraAvailable && status.pipelineInitialized;
  const outboundReady = status.cameraRoute === 'outbound';
  elements.headerStatus.className = `header-status ${meetReady && cameraReady && outboundReady ? 'online' : meetReady ? 'warning' : ''}`;
  elements.headerStatus.lastElementChild!.textContent = meetReady ? (outboundReady ? 'Live' : cameraReady ? 'Processing' : 'Meet found') : 'Offline';

  elements.heroTitle.textContent = status.effectActive ? 'You are off-camera.' : meetReady ? 'Ready when you are.' : 'Meet me on Google Meet.';
  elements.heroSubtitle.textContent = status.effectActive
    ? 'The outgoing camera is showing the replacement scene.'
    : meetReady
      ? 'Your camera stays local while Snap prepares the effect.'
      : 'Open a Google Meet call to route your camera through Snap.';
  elements.toggleEffect.disabled = !cameraReady;
  elements.toggleEffect.classList.toggle('active', status.effectActive);
  elements.toggleLabel.textContent = status.effectActive ? 'Reappear' : 'Disappear';

  setStatusItem(elements.meetIcon, elements.meetStatus, meetReady, meetReady ? 'Detected' : 'Not detected');
  setStatusItem(elements.cameraIcon, elements.cameraStatus, cameraReady, cameraReady ? (outboundReady ? 'Routed' : 'Processing') : 'Waiting', meetReady && !cameraReady);
  const modelReady = status.modelReady || !settings.realTimeRemoval;
  setStatusItem(elements.modelIcon, elements.modelStatus, modelReady, settings.realTimeRemoval ? (status.modelReady ? 'Ready' : 'Loading') : 'Paused', Boolean(status.error && settings.realTimeRemoval));
  setStatusItem(elements.effectIcon, elements.effectStatus, status.effectActive, status.effectActive ? 'Active' : 'Inactive');
  elements.processingPill.textContent = status.effectActive ? 'ACTIVE' : cameraReady ? 'READY' : 'IDLE';
  elements.processingPill.className = `live-pill ${status.effectActive ? 'active' : cameraReady ? 'ready' : ''}`;
  elements.statusMessage.textContent = status.error ?? status.message;
  elements.statusMessage.classList.toggle('error', Boolean(status.error));

  const plateReady = Boolean(background || status.backgroundAvailable);
  elements.backgroundBadge.textContent = status.backgroundMismatch ? 'RECAPTURE' : plateReady ? 'READY' : 'MISSING';
  elements.backgroundBadge.className = `mini-badge ${status.backgroundMismatch ? 'warn' : plateReady ? 'ready' : ''}`;
  elements.captureBackground.disabled = !cameraReady || status.effectActive;
  elements.deleteBackground.disabled = !plateReady;
  if (background?.dataUrl) {
    elements.backgroundImage.src = background.dataUrl;
    elements.backgroundImage.hidden = false;
    elements.backgroundPreview.querySelector('.preview-placeholder')?.setAttribute('hidden', 'true');
  } else {
    elements.backgroundImage.hidden = true;
    elements.backgroundPreview.querySelector('.preview-placeholder')?.removeAttribute('hidden');
  }

  elements.realtimeToggle.checked = settings.realTimeRemoval;
  elements.plateToggle.checked = settings.useBackgroundPlate;
  elements.animationToggle.checked = settings.animations;
  elements.intensitySlider.value = String(Math.round(settings.animationIntensity * 100));
  elements.intensityValue.value = `${Math.round(settings.animationIntensity * 100)}%`;
  elements.performanceSelect.value = settings.performanceMode;
  elements.snapToggle.checked = settings.snapDetection;
  elements.snapToggle.title = settings.snapDetection && !status.snapDetectionActive
    ? 'Enabled, but microphone detection is not active. Check the status message for permission details.'
    : 'Enable optional local finger-snap detection';
  elements.sensitivitySlider.value = String(Math.round(settings.snapSensitivity * 100));
  elements.sensitivityValue.value = `${Math.round(settings.snapSensitivity * 100)}%`;
}

function setStatusItem(icon: HTMLElement, label: HTMLElement, good: boolean, text: string, warning = false): void {
  const item = icon.parentElement;
  item?.classList.toggle('ok', good);
  item?.classList.toggle('warn', warning);
  item?.classList.toggle('active', good && text === 'Active');
  icon.textContent = good ? '●' : warning ? '!' : '○';
  label.textContent = text;
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 3600);
}

function isBackgroundPlate(value: unknown): value is BackgroundPlate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BackgroundPlate>;
  return typeof candidate.dataUrl === 'string' && typeof candidate.width === 'number' && typeof candidate.height === 'number';
}

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
