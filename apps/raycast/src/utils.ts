/**
 * Builds a Cap desktop deeplink URL.
 *
 * Cap desktop uses the URL scheme: cap-desktop://action?value={json_encoded_action}
 * The JSON value follows the Rust serde enum serialization format:
 * - Unit variants: "variant_name"
 * - Struct variants: { "variant_name": { field: value } }
 */
export function buildDeeplinkUrl(action: DeepLinkAction): string {
  const json = JSON.stringify(action);
  return `cap-desktop://action?value=${encodeURIComponent(json)}`;
}

// Unit variants serialize as plain strings
export type DeepLinkAction =
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "toggle_pause_recording"
  | StartRecordingAction
  | SetCameraAction
  | SetMicrophoneAction
  | OpenEditorAction
  | OpenSettingsAction;

export interface StartRecordingAction {
  start_recording: {
    capture_mode: { screen: string } | { window: string };
    camera: CameraId | null;
    mic_label: string | null;
    capture_system_audio: boolean;
    mode: "studio" | "instant";
  };
}

export type CameraId = { ModelID: string } | { DeviceID: string };

export interface SetCameraAction {
  set_camera: {
    camera: CameraId | null;
  };
}

export interface SetMicrophoneAction {
  set_microphone: {
    mic_label: string | null;
  };
}

export interface OpenEditorAction {
  open_editor: {
    project_path: string;
  };
}

export interface OpenSettingsAction {
  open_settings: {
    page: string | null;
  };
}
