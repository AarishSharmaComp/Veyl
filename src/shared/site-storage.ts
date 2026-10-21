import {
  BackgroundPlate,
  DEFAULT_SETTINGS,
  GLOBAL_ENABLED_KEY,
  MEET_SITE_KEY,
  SITE_PROFILES_KEY,
  SiteProfile,
  VeylSettings
} from './types';
import { describeSiteUrl } from './sites';
import { sanitizeSettings } from './settings';
import { isBackgroundPlate } from './background-plate';

export interface StoredVeylState {
  globalEnabled: boolean;
  profiles: Record<string, SiteProfile>;
}

export function migrateStoredState(stored: Record<string, unknown>): StoredVeylState {
  const rawProfiles = stored[SITE_PROFILES_KEY];
  const profiles: Record<string, SiteProfile> = Object.create(null);

  if (rawProfiles && typeof rawProfiles === 'object') {
    for (const [siteKey, value] of Object.entries(rawProfiles as Record<string, unknown>)) {
      const profile = sanitizeSiteProfile(siteKey, value);
      if (profile) profiles[profile.siteKey] = profile;
    }
  }

  const legacySettings = stored.settings as Partial<VeylSettings> | undefined;
  const legacyBackground = isBackgroundPlate(stored.background) ? stored.background : null;
  if (!profiles[MEET_SITE_KEY] && (legacySettings || legacyBackground)) {
    profiles[MEET_SITE_KEY] = createSiteProfile(MEET_SITE_KEY, true, legacySettings, legacyBackground);
  }
  if (!profiles[MEET_SITE_KEY]) profiles[MEET_SITE_KEY] = createSiteProfile(MEET_SITE_KEY, true);

  return {
    globalEnabled: stored[GLOBAL_ENABLED_KEY] !== false,
    profiles
  };
}

export function createSiteProfile(
  siteKey: string,
  enabled = false,
  settings?: Partial<VeylSettings>,
  background: BackgroundPlate | null = null
): SiteProfile {
  return {
    siteKey,
    enabled,
    settings: sanitizeSettings(settings),
    background,
    updatedAt: Date.now()
  };
}

export function sanitizeSiteProfile(siteKey: string, value: unknown): SiteProfile | null {
  const descriptor = describeSiteUrl(siteKey);
  if (!descriptor) return null;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SiteProfile>;
  return {
    siteKey: descriptor.siteKey,
    enabled: candidate.enabled === true,
    settings: sanitizeSettings(candidate.settings),
    background: isBackgroundPlate(candidate.background) ? candidate.background : null,
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : Date.now()
  };
}

export function getProfile(state: StoredVeylState, siteKey: string): SiteProfile | null {
  return state.profiles[siteKey] ?? null;
}

export function withProfile(state: StoredVeylState, profile: SiteProfile): StoredVeylState {
  return {
    ...state,
    profiles: {
      ...state.profiles,
      [profile.siteKey]: { ...profile, updatedAt: Date.now() }
    }
  };
}

export function withoutProfile(state: StoredVeylState, siteKey: string): StoredVeylState {
  const profiles = { ...state.profiles };
  delete profiles[siteKey];
  // Keep a disabled tombstone for the built-in site so migration cannot silently
  // re-enable it or resurrect the legacy background on the next browser start.
  if (siteKey === MEET_SITE_KEY) profiles[siteKey] = createSiteProfile(siteKey, false);
  return { ...state, profiles };
}

export function profileSettings(profile: SiteProfile | null): VeylSettings {
  return profile ? sanitizeSettings(profile.settings) : { ...DEFAULT_SETTINGS };
}
