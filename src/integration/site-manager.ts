import { createSiteProfile, migrateStoredState, withoutProfile, withProfile, type StoredVeylState } from '../shared/site-storage';
import { describeSiteUrl } from '../shared/sites';
import { sanitizeSettings } from '../shared/settings';
import { isBackgroundPlate } from '../shared/background-plate';
import type { FrameConfig, FrameControlMessage, SiteControlMessage, SiteDescriptor } from '../shared/types';

const PREFIX = 'veyl-site-';
const STATE_KEYS = ['settings', 'background', 'globalEnabled', 'siteProfiles'];

/** The worker is the only writer of profiles. Serial mutations avoid background
 * capture in one tab overwriting a site's permission/settings changes in another. */
export class SiteManager {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly browser: typeof chrome) {}

  serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    await this.serialize(async () => {
      await this.write(await this.read());
      await this.reconcile();
    });
  }

  async read(): Promise<StoredVeylState> {
    const stored = await this.browser.storage.local.get(STATE_KEYS);
    return migrateStoredState(stored as Record<string, unknown>);
  }

  async frameConfig(url: string): Promise<FrameConfig> {
    const site = requireSite(url);
    const state = await this.read();
    const profile = state.profiles[site.siteKey] ?? null;
    const hostPermissionGranted = await this.hasPermission(site);
    return { site, profile, globalEnabled: state.globalEnabled, hostPermissionGranted,
      enabled: state.globalEnabled && profile?.enabled === true && hostPermissionGranted };
  }

  async frameCommand(message: FrameControlMessage, url: string): Promise<unknown> {
    if (message.type === 'GET_FRAME_CONFIG') return { ok: true, config: await this.frameConfig(url) };
    return this.serialize(async () => {
      const config = await this.frameConfig(url);
      if (!config.enabled || !config.profile) throw new Error('Veyl is disabled on this website.');
      if (message.type === 'FRAME_BACKGROUND_CAPTURED' && !isBackgroundPlate(message.background)) {
        throw new Error('The captured background is not a supported local image.');
      }
      const state = await this.read();
      const background = message.type === 'FRAME_BACKGROUND_CAPTURED' ? message.background : null;
      await this.write(withProfile(state, { ...config.profile, background, updatedAt: Date.now() }));
      return { ok: true };
    });
  }

  async command(message: SiteControlMessage): Promise<unknown> {
    if (message.type === 'GET_GLOBAL_STATE') {
      const state = await this.read();
      return { ok: true, ...state };
    }
    if (message.type === 'GET_SITE_ACCESS') {
      const config = await this.frameConfig(message.siteKey);
      return { ok: true, access: config };
    }
    return this.serialize(async () => {
      const state = await this.read();
      if (message.type === 'SET_GLOBAL_ENABLED') {
        if (typeof message.enabled !== 'boolean') throw new Error('Invalid global Veyl state.');
        await this.write({ ...state, globalEnabled: message.enabled });
        await this.reconcile();
        await this.notify();
        return { ok: true, globalEnabled: message.enabled };
      }

      const site = requireSite(message.siteKey);
      const profile = state.profiles[site.siteKey] ?? createSiteProfile(site.siteKey);
      if (message.type === 'ENABLE_SITE') {
        if (!await this.hasPermission(site)) throw new Error('Grant this website permission in the Veyl popup first.');
        const next = { ...profile, enabled: true, updatedAt: Date.now() };
        await this.write(withProfile(state, next));
        try { await this.reconcile(); } catch (error) {
          await this.write(withProfile(state, { ...next, enabled: false }));
          throw error;
        }
        await this.notify(site.siteKey);
        return { ok: true, profile: next, reloadRequired: true };
      }
      if (message.type === 'DISABLE_SITE' || message.type === 'REMOVE_SITE') {
        const next = message.type === 'REMOVE_SITE' ? withoutProfile(state, site.siteKey)
          : withProfile(state, { ...profile, enabled: false, updatedAt: Date.now() });
        await this.write(next);
        await this.notify(site.siteKey);
        await this.reconcile();
        // The built-in required Meet permission cannot be removed at runtime;
        // its stored disabled profile still prevents all media processing.
        const permissionRemoved = message.type === 'REMOVE_SITE' && !site.isBuiltIn
          ? await this.browser.permissions.remove({ origins: [site.matchPattern] }) : false;
        return { ok: true, permissionRemoved };
      }
      if (message.type === 'SAVE_SITE_SETTINGS') {
        const next = { ...profile, settings: sanitizeSettings(message.settings), updatedAt: Date.now() };
        await this.write(withProfile(state, next));
        await this.notify(site.siteKey);
        return { ok: true, profile: next };
      }
      if (message.type === 'DELETE_SITE_BACKGROUND') {
        await this.write(withProfile(state, { ...profile, background: null, updatedAt: Date.now() }));
        await this.notify(site.siteKey);
        return { ok: true };
      }
      throw new Error('Unknown Veyl site command.');
    });
  }

  async permissionsChanged(): Promise<void> {
    await this.serialize(async () => {
      let state = await this.read();
      for (const profile of Object.values(state.profiles)) {
        const site = describeSiteUrl(profile.siteKey);
        if (site && profile.enabled && !await this.hasPermission(site)) {
          state = withProfile(state, { ...profile, enabled: false });
        }
      }
      await this.write(state);
      await this.notify();
      await this.reconcile();
    });
  }

  /** Persistent registrations preserve first-navigation timing at browser startup;
   * the isolated content gate still verifies current policy/permission on every page. */
  async reconcile(): Promise<void> {
    const state = await this.read();
    const desired = new Map<string, chrome.scripting.RegisteredContentScript>();
    for (const profile of Object.values(state.profiles)) {
      const site = describeSiteUrl(profile.siteKey);
      if (!site || site.isBuiltIn || !profile.enabled || !state.globalEnabled || !await this.hasPermission(site)) continue;
      for (const script of siteScripts(site)) desired.set(script.id, script);
    }
    const existing = await this.browser.scripting.getRegisteredContentScripts();
    const stale = existing.filter((script) => script.id.startsWith(PREFIX) && !desired.has(script.id));
    if (stale.length) await this.browser.scripting.unregisterContentScripts({ ids: stale.map((script) => script.id) });
    const byId = new Map(existing.map((script) => [script.id, script]));
    const additions = [...desired.values()].filter((script) => !byId.has(script.id));
    if (additions.length) await this.browser.scripting.registerContentScripts(additions);
    const updates = [...desired.values()].filter((script) => {
      const old = byId.get(script.id);
      return old && JSON.stringify([old.matches, old.js, old.world, old.runAt, old.persistAcrossSessions])
        !== JSON.stringify([script.matches, script.js, script.world, script.runAt, script.persistAcrossSessions]);
    });
    if (updates.length) await this.browser.scripting.updateContentScripts(updates);
  }

  private hasPermission(site: SiteDescriptor): Promise<boolean> {
    return this.browser.permissions.contains({ origins: [site.matchPattern] });
  }

  private write(state: StoredVeylState): Promise<void> {
    return this.browser.storage.local.set({ globalEnabled: state.globalEnabled, siteProfiles: state.profiles });
  }

  private async notify(siteKey?: string): Promise<void> {
    // No tabs permission or browsing-history access: only tab IDs are needed.
    // Broadcasts are ignored by unenabled pages; no per-site data is included.
    const tabs = await this.browser.tabs.query({});
    await Promise.all(tabs.filter((tab) => tab.id !== undefined).map((tab) =>
      this.browser.tabs.sendMessage(tab.id!, { type: 'POLICY_CHANGED', siteKey }).catch(() => undefined)));
  }
}

export function siteScripts(site: SiteDescriptor): chrome.scripting.RegisteredContentScript[] {
  const suffix = [...site.siteKey].reduce((hash, char) => BigInt.asUintN(64, (hash ^ BigInt(char.charCodeAt(0))) * 1099511628211n), 14695981039346656037n).toString(36);
  return (['ISOLATED', 'MAIN'] as const).map((world) => ({
    id: `${PREFIX}${world.toLowerCase()}-${suffix}`,
    matches: [site.matchPattern],
    js: [world === 'MAIN' ? 'page-bridge.js' : 'content.js'],
    runAt: 'document_start', world, allFrames: false, persistAcrossSessions: true
  }));
}

function requireSite(url: string): SiteDescriptor {
  const site = typeof url === 'string' ? describeSiteUrl(url) : null;
  if (!site) throw new Error('Use an HTTPS website or a localhost development origin.');
  return site;
}
