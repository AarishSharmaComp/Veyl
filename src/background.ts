import { SiteManager } from './integration/site-manager';
import type { FrameControlMessage, SiteControlMessage } from './shared/types';

const manager = new SiteManager(chrome);
const popupUrl = chrome.runtime.getURL('popup.html');
const popupCommands = new Set(['GET_GLOBAL_STATE', 'SET_GLOBAL_ENABLED', 'GET_SITE_ACCESS', 'ENABLE_SITE', 'DISABLE_SITE', 'REMOVE_SITE', 'SAVE_SITE_SETTINGS', 'DELETE_SITE_BACKGROUND']);
const frameCommands = new Set(['GET_FRAME_CONFIG', 'FRAME_BACKGROUND_CAPTURED', 'FRAME_BACKGROUND_DELETED']);

chrome.runtime.onInstalled.addListener(() => void manager.initialize().catch(report));
chrome.runtime.onStartup.addListener(() => void manager.initialize().catch(report));
chrome.permissions.onRemoved.addListener(() => void manager.permissionsChanged().catch(report));
chrome.permissions.onAdded.addListener(() => void manager.serialize(() => manager.reconcile()).catch(report));

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof (message as { type?: unknown }).type !== 'string') return false;
  const type = (message as { type: string }).type;
  if (!popupCommands.has(type) && !frameCommands.has(type)) return false;

  const command = async () => {
    if (sender.id !== chrome.runtime.id) throw new Error('Untrusted Veyl command.');
    if (frameCommands.has(type)) {
      if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.url) throw new Error('A top-level camera page is required.');
      return manager.frameCommand(message as FrameControlMessage, sender.url);
    }
    // A web-page message is never allowed to edit the enabled-site allowlist.
    if (sender.tab || sender.url?.split('?')[0] !== popupUrl) throw new Error('Use the Veyl popup to manage website access.');
    return manager.command(message as SiteControlMessage);
  };
  void command().then(sendResponse, (error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-disappearance') return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined || !tab.url) return;
    const config = await manager.frameConfig(tab.url);
    if (config.enabled) await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EFFECT', fromShortcut: true });
  })().catch(() => undefined);
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(error: unknown): void {
  console.error('[Veyl] Website policy could not be updated:', errorMessage(error));
}
