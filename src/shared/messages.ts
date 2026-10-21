export const PAGE_SOURCE = 'veyl-page';
export const CONTENT_SOURCE = 'veyl-content';

export interface BridgeMessage {
  source: string;
  type: string;
  sessionId?: string;
  requestId?: string;
  payload?: unknown;
}

const pageTypes = new Set(['READY', 'STATUS', 'BACKGROUND_CAPTURED', 'BACKGROUND_DELETED', 'GESTURE_DETECTED', 'COMMAND_RESULT', 'ERROR']);
const contentTypes = new Set(['PING', 'CONFIG', 'HEARTBEAT', 'DEACTIVATE', 'SET_SETTINGS', 'TOGGLE_EFFECT', 'CAPTURE_BACKGROUND', 'DELETE_BACKGROUND']);

export function isPageMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { source?: unknown; type?: unknown };
  return candidate.source === PAGE_SOURCE && typeof candidate.type === 'string' && pageTypes.has(candidate.type);
}

export function isContentMessage(value: unknown): value is BridgeMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { source?: unknown; type?: unknown };
  return candidate.source === CONTENT_SOURCE && typeof candidate.type === 'string' && contentTypes.has(candidate.type);
}
