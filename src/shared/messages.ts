export const PAGE_SOURCE = 'snap-page';
export const CONTENT_SOURCE = 'snap-content';

export function isPageMessage(value: unknown): value is { source: typeof PAGE_SOURCE; type: string; payload?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { source?: unknown; type?: unknown };
  return candidate.source === PAGE_SOURCE && typeof candidate.type === 'string';
}

export function isContentMessage(value: unknown): value is { source: typeof CONTENT_SOURCE; type: string; payload?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { source?: unknown; type?: unknown };
  return candidate.source === CONTENT_SOURCE && typeof candidate.type === 'string';
}
