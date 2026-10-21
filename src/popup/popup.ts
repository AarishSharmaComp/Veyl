import { migrateStoredState } from '../shared/site-storage';
import { describeSiteUrl, parseWebsiteEntry } from '../shared/sites';
import { sanitizeSettings } from '../shared/settings';
import { BackgroundPlate, DEFAULT_SETTINGS, DEFAULT_STATUS, ExtensionSnapshot, PipelineStatus, SiteAccessState, SiteControlMessage, SiteDescriptor, SiteProfile, VeylSettings } from '../shared/types';

interface ActiveTab {
  id: number;
  url: string;
  site: SiteDescriptor | null;
}

interface GlobalState {
  globalEnabled: boolean;
  profiles: Record<string, SiteProfile>;
}

let activeTab: ActiveTab | null = null;
let access: SiteAccessState | null = null;
let globalState: GlobalState = { globalEnabled: true, profiles: {} };
let settings: VeylSettings = { ...DEFAULT_SETTINGS };
let background: BackgroundPlate | null = null;
let status: PipelineStatus = { ...DEFAULT_STATUS };
let toastTimer = 0;

const elements = {
  headerStatus: get<HTMLElement>('header-status'),
  siteName: get<HTMLElement>('site-name'),
  siteBadge: get<HTMLElement>('site-badge'),
  siteHelp: get<HTMLElement>('site-help'),
  siteToggle: get<HTMLButtonElement>('site-toggle'),
  siteRemove: get<HTMLButtonElement>('site-remove'),
  globalToggle: get<HTMLInputElement>('global-toggle'),
  siteInput: get<HTMLInputElement>('site-input'),
  siteAdd: get<HTMLButtonElement>('site-add'),
  siteList: get<HTMLElement>('site-list'),
  heroTitle: get<HTMLElement>('hero-title'),
  heroSubtitle: get<HTMLElement>('hero-subtitle'),
  toggleEffect: get<HTMLButtonElement>('toggle-effect'),
  toggleLabel: get<HTMLElement>('toggle-label'),
  siteIcon: get<HTMLElement>('site-icon'),
  siteStatus: get<HTMLElement>('site-status'),
  cameraIcon: get<HTMLElement>('camera-icon'),
  cameraStatus: get<HTMLElement>('camera-status'),
  modelIcon: get<HTMLElement>('model-icon'),
  modelStatus: get<HTMLElement>('model-status'),
  effectIcon: get<HTMLElement>('effect-icon'),
  effectStatus: get<HTMLElement>('effect-status'),
  statusMessage: get<HTMLElement>('status-message'),
  processingPill: get<HTMLElement>('processing-pill'),
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
  gestureToggle: get<HTMLInputElement>('gesture-toggle'),
  sensitivitySlider: get<HTMLInputElement>('sensitivity-slider'),
  sensitivityValue: get<HTMLOutputElement>('sensitivity-value'),
  cooldownSlider: get<HTMLInputElement>('cooldown-slider'),
  cooldownValue: get<HTMLOutputElement>('cooldown-value'),
  gestureStatus: get<HTMLElement>('gesture-status'),
  toast: get<HTMLElement>('toast')
};

void initialize().catch((error) => {
  status = { ...DEFAULT_STATUS, error: `Veyl could not load local state: ${toErrorMessage(error)}`, message: 'Reload the Veyl popup and try again.' };
  render();
});

async function initialize(): Promise<void> {
  const stored = await chrome.storage.local.get(['settings', 'background', 'globalEnabled', 'siteProfiles']);
  globalState = migrateStoredState(stored as Record<string, unknown>);
  settings = { ...DEFAULT_SETTINGS };
  bindControls();
  await refreshActiveTab();
  render();
  window.setInterval(() => void refreshActiveTab().catch(() => undefined), 1200);
}

function bindControls(): void {
  elements.siteToggle.addEventListener('click', () => void toggleCurrentSite());
  elements.siteRemove.addEventListener('click', () => void removeCurrentSite());
  elements.siteAdd.addEventListener('click', () => void addWebsite());
  elements.siteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void addWebsite();
  });
  elements.globalToggle.addEventListener('change', () => void setGlobalEnabled(elements.globalToggle.checked));
  elements.toggleEffect.addEventListener('click', () => void sendToContent({ type: 'TOGGLE_EFFECT' }).then((response) => {
    if (!response?.ok) showToast(response?.error ?? 'Reload this website to connect Veyl.');
    void refreshActiveTab();
  }));
  elements.captureBackground.addEventListener('click', async () => {
    const response = await sendToContent({ type: 'CAPTURE_BACKGROUND' });
    if (response?.ok) showToast('Clean background captured and saved on this device.');
    else showToast(response?.error ?? 'Enable Veyl and reload this website first.');
  });
  elements.deleteBackground.addEventListener('click', async () => {
    if (!activeTab?.site) return;
    const response = await sendSiteControl({ type: 'DELETE_SITE_BACKGROUND', siteKey: activeTab.site.siteKey });
    if (response?.ok) {
      background = null;
      render();
      showToast('Background plate deleted.');
    } else showToast(response?.error ?? 'Background plate could not be deleted.');
  });

  elements.realtimeToggle.addEventListener('change', () => void updateSetting({ realTimeRemoval: elements.realtimeToggle.checked }));
  elements.plateToggle.addEventListener('change', () => void updateSetting({ useBackgroundPlate: elements.plateToggle.checked }));
  elements.animationToggle.addEventListener('change', () => void updateSetting({ animations: elements.animationToggle.checked }));
  elements.intensitySlider.addEventListener('input', () => {
    const animationIntensity = Number(elements.intensitySlider.value) / 100;
    elements.intensityValue.value = `${Math.round(animationIntensity * 100)}%`;
    void updateSetting({ animationIntensity });
  });
  elements.performanceSelect.addEventListener('change', () => void updateSetting({ performanceMode: elements.performanceSelect.value as VeylSettings['performanceMode'] }));
  elements.gestureToggle.addEventListener('change', () => void updateSetting({ gestureDetection: elements.gestureToggle.checked }));
  elements.sensitivitySlider.addEventListener('input', () => {
    const gestureSensitivity = Number(elements.sensitivitySlider.value) / 100;
    elements.sensitivityValue.value = `${Math.round(gestureSensitivity * 100)}%`;
    void updateSetting({ gestureSensitivity });
  });
  elements.cooldownSlider.addEventListener('input', () => {
    const gestureCooldownMs = Number(elements.cooldownSlider.value);
    elements.cooldownValue.value = formatCooldown(gestureCooldownMs);
    void updateSetting({ gestureCooldownMs });
  });
}

async function refreshActiveTab(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const candidate = tabs[0];
  const site = candidate?.url ? describeSiteUrl(candidate.url) : null;
  activeTab = candidate?.id && candidate.url ? { id: candidate.id, url: candidate.url, site } : null;
  const globalResponse = await sendSiteControl({ type: 'GET_GLOBAL_STATE' });
  if (globalResponse?.ok) globalState = { globalEnabled: globalResponse.globalEnabled, profiles: globalResponse.profiles };

  if (!activeTab || !site) {
    access = null;
    status = { ...DEFAULT_STATUS, siteDetected: false, message: 'Open an HTTPS camera website to use Veyl.' };
    settings = { ...DEFAULT_SETTINGS };
    background = null;
    render();
    return;
  }

  const accessResponse = await sendSiteControl({ type: 'GET_SITE_ACCESS', siteKey: site.siteKey });
  access = accessResponse?.access ?? null;
  const response = await sendToContent({ type: 'GET_STATUS' });
  if (response?.ok && response.snapshot) {
    const snapshot = response.snapshot as ExtensionSnapshot;
    settings = sanitizeSettings(snapshot.settings);
    background = snapshot.background;
    status = { ...snapshot.status, siteDetected: true, siteEnabled: Boolean(access?.globalEnabled && access?.profile?.enabled && access.hostPermissionGranted) };
  } else {
    const profile = access?.profile;
    settings = sanitizeSettings(profile?.settings);
    background = profile?.background ?? null;
    status = {
      ...DEFAULT_STATUS,
      siteKey: site.siteKey,
      siteLabel: site.label,
      siteDetected: true,
      siteEnabled: Boolean(access?.globalEnabled && access?.profile?.enabled && access.hostPermissionGranted),
      hostPermissionGranted: Boolean(access?.hostPermissionGranted),
      bridgeReady: false,
      message: access?.profile?.enabled ? 'Reload this website to connect Veyl before its camera starts.' : 'Enable Veyl on this website to begin.'
    };
  }
  render();
}

async function toggleCurrentSite(): Promise<void> {
  const site = activeTab?.site;
  if (!site) return;
  if (access?.profile?.enabled && access.hostPermissionGranted) {
    const response = await sendSiteControl({ type: 'DISABLE_SITE', siteKey: site.siteKey });
    if (response?.ok) {
      showToast('Veyl disabled here. The current page has been deactivated.');
      await refreshActiveTab();
    } else showToast(response?.error ?? 'This website could not be disabled.');
    return;
  }
  await enableSite(site);
}

async function enableSite(site: SiteDescriptor): Promise<void> {
  try {
    const granted = site.isBuiltIn || await chrome.permissions.request({ origins: [site.matchPattern] });
    if (!granted) {
      showToast('Veyl needs permission for this website before it can process its camera.');
      return;
    }
    const response = await sendSiteControl({ type: 'ENABLE_SITE', siteKey: site.siteKey });
    if (!response?.ok) {
      showToast(response?.error ?? 'Veyl could not enable this website.');
      return;
    }
    showToast('Enabled. Reload the website so Veyl can connect before its camera starts.');
    await refreshActiveTab();
  } catch (error) {
    showToast(`Website permission failed: ${toErrorMessage(error)}`);
  }
}

async function addWebsite(): Promise<void> {
  const value = elements.siteInput.value.trim();
  const site = parseWebsiteEntry(value);
  if (!site) {
    showToast('Enter an HTTPS website or localhost development URL.');
    return;
  }
  await enableSite(site);
  elements.siteInput.value = '';
}

async function removeCurrentSite(): Promise<void> {
  const site = activeTab?.site;
  if (!site) return;
  const response = await sendSiteControl({ type: 'REMOVE_SITE', siteKey: site.siteKey });
  if (response?.ok) {
    showToast(site.isBuiltIn ? 'Veyl disabled on Google Meet. Its built-in host permission remains installed.' : 'Website removed and permission released.');
    await refreshActiveTab();
  } else showToast(response?.error ?? 'Website could not be removed.');
}

async function setGlobalEnabled(enabled: boolean): Promise<void> {
  const response = await sendSiteControl({ type: 'SET_GLOBAL_ENABLED', enabled });
  if (!response?.ok) {
    elements.globalToggle.checked = !enabled;
    showToast(response?.error ?? 'Global Veyl state could not be changed.');
    return;
  }
  globalState.globalEnabled = enabled;
  showToast(enabled ? 'Veyl is enabled globally.' : 'Veyl is suspended on every website.');
  await refreshActiveTab();
}

async function updateSetting(partial: Partial<VeylSettings>): Promise<void> {
  settings = sanitizeSettings({ ...settings, ...partial });
  render();
  if (!activeTab?.site) return;
  const saveResponse = await sendSiteControl({ type: 'SAVE_SITE_SETTINGS', siteKey: activeTab.site.siteKey, settings });
  if (!saveResponse?.ok) {
    showToast(saveResponse?.error ?? 'Settings could not be saved.');
    return;
  }
  if (status.siteEnabled) {
    const response = await sendToContent({ type: 'SET_SETTINGS', settings });
    if (!response?.ok) showToast(response?.error ?? 'Reload the website to apply this setting.');
  }
}

async function sendSiteControl(message: SiteControlMessage): Promise<any> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return null;
  }
}

async function sendToContent(message: { type: string; settings?: VeylSettings }): Promise<{ ok?: boolean; snapshot?: ExtensionSnapshot; error?: string } | null> {
  if (!activeTab) return null;
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    return null;
  }
}

function render(): void {
  const site = activeTab?.site ?? null;
  const siteEnabled = Boolean(site && globalState.globalEnabled && access?.profile?.enabled && access.hostPermissionGranted);
  const cameraReady = status.cameraAvailable && status.pipelineInitialized;
  const outboundReady = status.cameraRoute === 'outbound';
  const bridgeReady = status.bridgeReady;

  elements.globalToggle.checked = globalState.globalEnabled;
  elements.headerStatus.className = `header-status ${siteEnabled && cameraReady && outboundReady ? 'online' : siteEnabled ? 'warning' : ''}`;
  elements.headerStatus.lastElementChild!.textContent = siteEnabled ? (outboundReady ? 'Live' : cameraReady ? 'Processing' : 'Enabled') : 'Paused';

  elements.siteName.textContent = site?.origin ?? 'No supported website';
  elements.siteName.title = site?.origin ?? '';
  const siteReady = Boolean(site && globalState.globalEnabled && access?.profile?.enabled && access.hostPermissionGranted);
  elements.siteBadge.textContent = !site ? 'OFF' : siteReady ? (bridgeReady ? 'READY' : 'RELOAD') : access?.hostPermissionGranted ? 'OFF' : 'LOCKED';
  elements.siteBadge.className = `mini-badge ${siteReady && bridgeReady ? 'ready' : siteReady ? 'warn' : ''}`;
  elements.siteHelp.textContent = !site
    ? 'Open an HTTPS camera website, then enable Veyl for that origin.'
    : !globalState.globalEnabled ? 'Veyl is paused globally. Turn it on to reconnect enabled sites.'
      : siteReady && !bridgeReady
        ? 'Reload this website so Veyl can connect before the camera starts.'
        : access?.hostPermissionGranted
          ? siteReady ? 'Site access is enabled. A connected sender is not proof of remote delivery.' : 'Permission is available. Enable Veyl here to process this website’s camera.'
          : 'Veyl will request permission only for this exact website origin.';
  elements.siteToggle.disabled = !site || !globalState.globalEnabled;
  elements.siteToggle.textContent = access?.profile?.enabled && access.hostPermissionGranted ? 'Disable on this site' : 'Enable on this site';
  elements.siteRemove.disabled = !site || !access?.profile;

  const degradedEffect = status.effectActive && (!settings.useBackgroundPlate || !status.backgroundAvailable);
  elements.heroTitle.textContent = degradedEffect ? 'Fallback only — still visible.' : status.effectActive ? 'You are off-camera.' : siteReady ? 'Ready when you are.' : 'Choose where Veyl runs.';
  elements.heroSubtitle.textContent = status.effectActive
    ? degradedEffect ? 'Capture a clean plate to remove the person. Blur does not reconstruct hidden scenery.' : 'Check the remote participant to verify the replacement scene.'
    : siteReady
      ? 'Your camera stays local while Veyl prepares the effect.'
      : 'Enable Veyl for this origin before connecting its camera.';
  elements.toggleEffect.disabled = !siteEnabled || !cameraReady;
  elements.toggleEffect.classList.toggle('active', status.effectActive);
  elements.toggleLabel.textContent = status.effectActive ? 'Reappear' : 'Disappear';

  setStatusItem(elements.siteIcon, elements.siteStatus, Boolean(siteReady && bridgeReady), siteReady ? (bridgeReady ? 'Connected' : 'Reload') : 'Disabled', Boolean(site && !siteReady));
  setStatusItem(elements.cameraIcon, elements.cameraStatus, cameraReady, cameraReady ? (outboundReady ? 'Routed' : 'Processing') : 'Waiting', siteReady && !cameraReady);
  setStatusItem(elements.modelIcon, elements.modelStatus, status.modelReady, !settings.realTimeRemoval ? 'Paused'
    : status.modelReady ? 'Ready' : !cameraReady ? 'On demand' : status.error ? 'Unavailable' : 'Loading', Boolean(status.error && settings.realTimeRemoval));
  setStatusItem(elements.effectIcon, elements.effectStatus, status.effectActive, status.effectActive ? (outboundReady ? 'Sender attached' : 'Local / unverified') : 'Inactive');
  elements.processingPill.textContent = status.effectActive ? (outboundReady ? 'ACTIVE' : 'LOCAL') : cameraReady ? 'READY' : 'IDLE';
  elements.processingPill.className = `live-pill ${status.effectActive ? 'active' : cameraReady ? 'ready' : ''}`;
  elements.statusMessage.textContent = status.error ?? status.message;
  elements.statusMessage.classList.toggle('error', Boolean(status.error));

  const plateReady = Boolean(background || status.backgroundAvailable);
  elements.backgroundBadge.textContent = status.backgroundMismatch ? 'RECAPTURE' : plateReady ? 'READY' : 'MISSING';
  elements.backgroundBadge.className = `mini-badge ${status.backgroundMismatch ? 'warn' : plateReady ? 'ready' : ''}`;
  elements.captureBackground.disabled = !siteEnabled || !cameraReady || status.effectActive;
  elements.deleteBackground.disabled = !background;
  elements.captureBackground.textContent = plateReady ? 'Recapture background' : 'Capture background';
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
  elements.gestureToggle.checked = settings.gestureDetection;
  elements.sensitivitySlider.value = String(Math.round(settings.gestureSensitivity * 100));
  elements.sensitivityValue.value = `${Math.round(settings.gestureSensitivity * 100)}%`;
  elements.cooldownSlider.value = String(settings.gestureCooldownMs);
  elements.cooldownValue.value = formatCooldown(settings.gestureCooldownMs);
  elements.gestureStatus.textContent = !settings.gestureDetection
    ? 'Camera gesture detection is off.'
    : status.gestureDetectionActive
      ? status.handTracked
        ? `Hand tracked${status.gestureCandidate ? ' — contact candidate' : ''}. `
          + `Inference ${status.handInferenceMs}ms. Hold thumb + middle together briefly, then curl the middle finger quickly toward your palm.`
        : `Detection is ready. Show one steady hand to the camera. Last inference ${status.handInferenceMs}ms.`
      : 'Gesture detection is loading or unavailable. Manual controls remain available.';

  renderSiteList();
}

function renderSiteList(): void {
  elements.siteList.replaceChildren();
  const profiles = Object.values(globalState.profiles);
  for (const profile of profiles) {
    const descriptor = describeSiteUrl(profile.siteKey);
    if (!descriptor) continue;
    const row = document.createElement('div');
    row.className = `site-list-item ${activeTab?.site?.siteKey === descriptor.siteKey ? 'current' : ''}`;
    const dot = document.createElement('span');
    dot.className = `site-list-dot ${profile.enabled ? '' : 'disabled'}`;
    const name = document.createElement('span');
    name.className = 'site-list-name';
    name.textContent = descriptor.origin;
    name.title = descriptor.origin;
    const toggle = document.createElement('button');
    toggle.className = 'site-list-toggle';
    toggle.textContent = profile.enabled ? 'Pause' : 'Enable';
    toggle.setAttribute('aria-label', `${profile.enabled ? 'Pause' : 'Enable'} Veyl on ${descriptor.origin}`);
    toggle.addEventListener('click', () => {
      if (!profile.enabled) { void enableSite(descriptor); return; }
      void sendSiteControl({ type: 'DISABLE_SITE', siteKey: descriptor.siteKey }).then((response) => {
        if (!response?.ok) showToast(response?.error ?? 'The website could not be paused.');
        void refreshActiveTab();
      });
    });
    const remove = document.createElement('button');
    remove.className = 'site-list-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${descriptor.origin}`);
    remove.addEventListener('click', () => void sendSiteControl({ type: 'REMOVE_SITE', siteKey: descriptor.siteKey }).then((response) => {
      showToast(response?.ok ? descriptor.isBuiltIn ? 'Google Meet paused. Its built-in permission remains.' : 'Website removed.' : response?.error ?? 'The website could not be removed.');
      void refreshActiveTab();
    }));
    row.replaceChildren(dot, name, toggle, remove);
    elements.siteList.append(row);
  }
}

function setStatusItem(icon: HTMLElement, label: HTMLElement, good: boolean, text: string, warning = false): void {
  const item = icon.parentElement;
  item?.classList.toggle('ok', good);
  item?.classList.toggle('warn', warning);
  icon.textContent = good ? '●' : warning ? '!' : '○';
  label.textContent = text;
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  toastTimer = window.setTimeout(() => elements.toast.classList.remove('visible'), 3600);
}

function formatCooldown(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function get<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Veyl popup element: ${id}`);
  return element as T;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
