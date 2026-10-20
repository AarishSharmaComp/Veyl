export type PerformanceMode = 'quality' | 'balanced' | 'performance';
export type CameraRoute = 'waiting' | 'original' | 'processed' | 'outbound';

export interface SnapSettings {
  realTimeRemoval: boolean;
  useBackgroundPlate: boolean;
  snapDetection: boolean;
  snapSensitivity: number;
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

export interface PipelineStatus {
  siteDetected: boolean;
  cameraAvailable: boolean;
  pipelineInitialized: boolean;
  cameraRoute: CameraRoute;
  modelReady: boolean;
  effectActive: boolean;
  backgroundAvailable: boolean;
  backgroundMismatch: boolean;
  snapDetectionActive: boolean;
  fps: number;
  inferenceMs: number;
  usingBackgroundPlate: boolean;
  message: string;
  error: string | null;
}

export interface ExtensionSnapshot {
  settings: SnapSettings;
  background: BackgroundPlate | null;
  status: PipelineStatus;
}

export interface PageInitPayload {
  settings: SnapSettings;
  background: BackgroundPlate | null;
  assetBaseUrl: string;
}

export interface PageEvent {
  source: 'snap-page';
  type:
    | 'READY'
    | 'STATUS'
    | 'BACKGROUND_CAPTURED'
    | 'BACKGROUND_DELETED'
    | 'ERROR';
  payload?: unknown;
}

export interface ContentMessage {
  type:
    | 'GET_STATUS'
    | 'TOGGLE_EFFECT'
    | 'CAPTURE_BACKGROUND'
    | 'DELETE_BACKGROUND'
    | 'SET_SETTINGS';
  settings?: SnapSettings;
}

export const DEFAULT_SETTINGS: SnapSettings = {
  realTimeRemoval: true,
  useBackgroundPlate: true,
  snapDetection: false,
  snapSensitivity: 0.62,
  animations: true,
  animationIntensity: 0.7,
  performanceMode: 'balanced'
};

export const DEFAULT_STATUS: PipelineStatus = {
  siteDetected: true,
  cameraAvailable: false,
  pipelineInitialized: false,
  cameraRoute: 'waiting',
  modelReady: false,
  effectActive: false,
  backgroundAvailable: false,
  backgroundMismatch: false,
  snapDetectionActive: false,
  fps: 0,
  inferenceMs: 0,
  usingBackgroundPlate: false,
  message: 'Waiting for Google Meet camera',
  error: null
};
