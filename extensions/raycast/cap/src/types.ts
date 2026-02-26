export type RecordingMode = "studio" | "instant" | "screenshot";
export type CaptureMode = "screen" | "window" | "area" | "camera";

export interface StartRecordingOptions {
  capture_mode: CaptureMode;
  camera?: { DeviceID: string } | { ModelID: string } | null;
  mic_label?: string | null;
  capture_system_audio?: boolean;
  mode?: RecordingMode;
}

export interface SwitchMicrophoneOptions {
  mic_label: string | null;
}

export interface SwitchCameraOptions {
  camera: { DeviceID: string } | { ModelID: string } | null;
}

export interface OpenSettingsOptions {
  page?: string | null;
}
