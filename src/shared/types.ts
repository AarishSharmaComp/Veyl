export type PerformanceMode = 'quality' | 'balanced' | 'performance';
export type CameraRoute = 'waiting' | 'original' | 'processed' | 'outbound';

export interface VeylSettings {
  realTimeRemoval: boolean;
  useBackgroundPlate: boolean;
  gestureDetection: boolean;
  gestureSensitivity: number;
  gestureCooldownMs: number;
  animations: boolean;
  animationIntensity: number;
  performanceMode: PerformanceMode;
}

export interface BackgroundPlate {
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface SiteProfile {
  siteKey: string;
  enabled: boolean;
  settings: VeylSettings;
  background: BackgroundPlate | null;
  updatedAt: number;
}

export interface SiteDescriptor {
  siteKey: string;
  origin: string;
  matchPattern: string;
  hostname: string;
  label: string;
  isBuiltIn: boolean;
}

export interface SiteAccessState {
  globalEnabled: boolean;
  hostPermissionGranted: boolean;
  profile: SiteProfile | null;
  site: SiteDescriptor | null;
}

export interface PipelineStatus {
  siteKey: string | null;
  siteLabel: string;
  siteDetected: boolean;
  siteEnabled: boolean;
  hostPermissionGranted: boolean;
  bridgeReady: boolean;
  reloadRequired: boolean;
  cameraAvailable: boolean;
  pipelineInitialized: boolean;
  cameraRoute: CameraRoute;
  modelReady: boolean;
  effectActive: boolean;
  backgroundAvailable: boolean;
  backgroundMismatch: boolean;
  gestureDetectionActive: boolean;
  handTracked: boolean;
  lastGestureAt: number | null;
  fps: number;
  inferenceMs: number;
  usingBackgroundPlate: boolean;
  message: string;
  error: string | null;
}

export interface ExtensionSnapshot {
  globalEnabled: boolean;
  site: SiteDescriptor | null;
  settings: VeylSettings;
  background: BackgroundPlate | null;
  status: PipelineStatus;
}

export interface PageInitPayload {
  siteKey: string;
  sessionId: string;
  siteLabel: string;
  settings: VeylSettings;
  background: BackgroundPlate | null;
  assetBaseUrl: string;
  siteEnabled: boolean;
  hostPermissionGranted: boolean;
}

export interface PageEvent {
  source: 'veyl-page';
  type:
    | 'READY'
    | 'STATUS'
    | 'BACKGROUND_CAPTURED'
    | 'BACKGROUND_DELETED'
    | 'GESTURE_DETECTED'
    | 'ERROR';
  payload?: unknown;
}

export interface ContentMessage {
  type:
    | 'GET_STATUS'
    | 'TOGGLE_EFFECT'
    | 'CAPTURE_BACKGROUND'
    | 'DELETE_BACKGROUND'
    | 'SET_SETTINGS'
    | 'DEACTIVATE';
  settings?: VeylSettings;
}

export type SiteControlMessage =
  | { type: 'GET_SITE_ACCESS'; siteKey: string }
  | { type: 'ENABLE_SITE'; siteKey: string }
  | { type: 'DISABLE_SITE'; siteKey: string }
  | { type: 'REMOVE_SITE'; siteKey: string }
  | { type: 'SAVE_SITE_SETTINGS'; siteKey: string; settings: VeylSettings }
  | { type: 'DELETE_SITE_BACKGROUND'; siteKey: string }
  | { type: 'SET_GLOBAL_ENABLED'; enabled: boolean }
  | { type: 'GET_GLOBAL_STATE' };

export type FrameControlMessage =
  | { type: 'GET_FRAME_CONFIG' }
  | { type: 'FRAME_BACKGROUND_CAPTURED'; background: BackgroundPlate }
  | { type: 'FRAME_BACKGROUND_DELETED' };

export interface FrameConfig {
  globalEnabled: boolean;
  enabled: boolean;
  hostPermissionGranted: boolean;
  site: SiteDescriptor;
  profile: SiteProfile | null;
}

export const DEFAULT_SETTINGS: VeylSettings = {
  realTimeRemoval: true,
  useBackgroundPlate: true,
  gestureDetection: false,
  gestureSensitivity: 0.62,
  gestureCooldownMs: 1100,
  animations: true,
  animationIntensity: 0.7,
  performanceMode: 'balanced'
};

export const DEFAULT_STATUS: PipelineStatus = {
  siteKey: null,
  siteLabel: 'Current website',
  siteDetected: false,
  siteEnabled: false,
  hostPermissionGranted: false,
  bridgeReady: false,
  reloadRequired: false,
  cameraAvailable: false,
  pipelineInitialized: false,
  cameraRoute: 'waiting',
  modelReady: false,
  effectActive: false,
  backgroundAvailable: false,
  backgroundMismatch: false,
  gestureDetectionActive: false,
  handTracked: false,
  lastGestureAt: null,
  fps: 0,
  inferenceMs: 0,
  usingBackgroundPlate: false,
  message: 'Veyl is waiting for an enabled website.',
  error: null
};

export const MEET_SITE_KEY = 'https://meet.google.com';
export const GLOBAL_ENABLED_KEY = 'globalEnabled';
export const SITE_PROFILES_KEY = 'siteProfiles';
