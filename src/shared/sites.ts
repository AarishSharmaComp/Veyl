import { MEET_SITE_KEY, SiteDescriptor } from './types';

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1']);

export function describeSiteUrl(value: string | URL | Location): SiteDescriptor | null {
  const url = toUrl(value);
  if (!url || !isSupportedProtocol(url)) return null;
  if (url.username || url.password || !url.hostname || /[\s*%]/.test(url.hostname)) return null;

  const origin = url.origin;
  if (origin === 'null') return null;
  const hostname = url.hostname.toLowerCase();
  const siteKey = origin;
  const isBuiltIn = siteKey === MEET_SITE_KEY;

  return {
    siteKey,
    origin,
    matchPattern: toMatchPattern(url),
    hostname,
    label: hostname === 'meet.google.com' ? 'Google Meet' : hostname,
    isBuiltIn
  };
}

export function isSupportedSiteUrl(value: string | URL | Location): boolean {
  return describeSiteUrl(value) !== null;
}

export function isBuiltInSite(siteKey: string): boolean {
  return siteKey === MEET_SITE_KEY;
}

export function toMatchPattern(value: URL): string {
  // Chrome treats an omitted match-pattern port as *, not the default port.
  // Spell out the default as well so a profile for :443 never injects on :8443.
  const port = value.port || (value.protocol === 'https:' ? '443' : '80');
  return `${value.protocol}//${value.hostname}:${port}/*`;
}

export function parseWebsiteEntry(value: string): SiteDescriptor | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\\]/.test(trimmed)) return null;
  // Do not turn javascript: / data: / browser URLs into apparent HTTPS hosts.
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)
      && !/^[\w.-]+:\d+(?:\/|$)/.test(trimmed)) return null;
  return describeSiteUrl(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
}

export function sameSite(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function toUrl(value: string | URL | Location): URL | null {
  try {
    if (value instanceof URL) return new URL(value.href);
    if (typeof value === 'string') return new URL(value);
    return new URL(value.href);
  } catch {
    return null;
  }
}

function isSupportedProtocol(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCALHOST_NAMES.has(url.hostname.toLowerCase());
}
