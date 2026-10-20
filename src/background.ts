import { DEFAULT_SETTINGS } from './shared/types';

chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.get('settings').then((stored) => {
    if (!stored.settings) {
      return chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
    return undefined;
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-disappearance') return;

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EFFECT' });
  } catch {
    // The content script is deliberately limited to Meet. Other tabs are ignored.
  }
});
