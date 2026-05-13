import {
  closeMainWindow,
  environment,
  getPreferenceValues,
  open,
  showToast,
  Toast,
} from "@raycast/api";

export type RecordingMode = "studio" | "instant" | "screenshot";
export type CaptureMode = { screen: string } | { window: string };
export type CameraId = { DeviceID: string } | { ModelID: string };

type CapAction =
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | {
      start_recording: {
        capture_mode: CaptureMode;
        camera: CameraId | null;
        mic_label: string | null;
        capture_system_audio: boolean;
        mode: RecordingMode;
      };
    }
  | { set_microphone: { mic_label: string | null } }
  | { set_camera: { camera: CameraId | null } };

export type Preferences = {
  defaultScreenName?: string;
  defaultWindowName?: string;
  microphoneLabel?: string;
  cameraDeviceId?: string;
  captureSystemAudio?: boolean;
  recordingMode?: RecordingMode;
};

export function actionUrl(action: CapAction): string {
  return `cap://action?value=${encodeURIComponent(JSON.stringify(action))}`;
}

export async function runAction(
  action: CapAction,
  message: string,
): Promise<void> {
  await open(actionUrl(action));
  if (!environment.isDevelopment)
    await closeMainWindow({ clearRootSearch: true });
  await showToast({ style: Toast.Style.Success, title: message });
}

export function preferences(): Preferences {
  return getPreferenceValues<Preferences>();
}

export function cameraFromPreference(value?: string): CameraId | null {
  return value?.trim() ? { DeviceID: value.trim() } : null;
}

export function micFromPreference(value?: string): string | null {
  return value?.trim() || null;
}
