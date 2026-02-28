import { open } from "@raycast/api";

export type CaptureMode =
  | { screen: string }
  | { window: string };

export type RecordingMode = "studio" | "instant" | "screenshot";

export interface StartRecordingOptions {
  capture_mode: CaptureMode;
  camera?: string;
  mic_label?: string;
  capture_system_audio: boolean;
  mode: RecordingMode;
}

export interface SwitchCameraOptions {
  camera: string;
}

export interface SwitchMicrophoneOptions {
  mic_label: string;
}

export type DeepLinkAction =
  | { start_recording: StartRecordingOptions }
  | { stop_recording: {} }
  | { pause_recording: {} }
  | { resume_recording: {} }
  | { toggle_pause_recording: {} }
  | { switch_camera: SwitchCameraOptions }
  | { switch_microphone: SwitchMicrophoneOptions };

export async function executeCapAction(action: DeepLinkAction): Promise<void> {
  const actionJson = JSON.stringify(action);
  const encodedAction = encodeURIComponent(actionJson);
  const deepLink = `cap://action?value=${encodedAction}`;
  
  await open(deepLink);
}
