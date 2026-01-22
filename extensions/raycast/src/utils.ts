import { closeMainWindow, getApplications, Keyboard, open, showHUD, showToast, Toast } from "@raycast/api";

const CAP_BUNDLE_ID = "so.cap.desktop";
const CAP_DEV_BUNDLE_ID = "so.cap.desktop.dev";
const CAP_URL_SCHEME = "cap-desktop";

export interface DeepLinkAction {
  [key: string]: unknown;
}

export async function capNotInstalled(showErrorToast = true): Promise<boolean> {
  const apps = await getApplications();
  const installed = apps.some(
    (app) => app.bundleId === CAP_BUNDLE_ID || app.bundleId === CAP_DEV_BUNDLE_ID
  );

  if (!installed && showErrorToast) {
    showToast({
      style: Toast.Style.Failure,
      title: "Cap is not installed!",
      primaryAction: {
        title: "Install Cap",
        shortcut: Keyboard.Shortcut.Common.Open,
        onAction: () => {
          open("https://cap.so/download");
        },
      },
    });
  }

  return !installed;
}

export async function executeCapAction(
  action: DeepLinkAction,
  options?: {
    feedbackMessage?: string;
    feedbackType?: "toast" | "hud";
  }
): Promise<boolean> {
  if (await capNotInstalled()) {
    return false;
  }

  const jsonValue = JSON.stringify(action);
  const encodedValue = encodeURIComponent(jsonValue);
  const url = `${CAP_URL_SCHEME}://action?value=${encodedValue}`;

  await closeMainWindow({ clearRootSearch: true });
  await open(url);

  if (options?.feedbackMessage) {
    if (!options.feedbackType || options.feedbackType === "toast") {
      showToast({ style: Toast.Style.Success, title: options.feedbackMessage });
    } else {
      showHUD(options.feedbackMessage);
    }
  }

  return true;
}

export interface RecordingStatus {
  is_recording: boolean;
  is_paused: boolean;
  recording_mode: string | null;
}

export interface DeepLinkCamera {
  name: string;
  id: string;
}

export interface DeepLinkScreen {
  name: string;
  id: string;
}

export interface DeepLinkWindow {
  name: string;
  owner_name: string;
}

export interface DeepLinkDevices {
  cameras: DeepLinkCamera[];
  microphones: string[];
  screens: DeepLinkScreen[];
  windows: DeepLinkWindow[];
}

export type RecordingMode = "instant" | "studio";

export interface CaptureMode {
  screen?: string;
  window?: string;
}

export function createStartRecordingAction(
  captureMode: CaptureMode,
  mode: RecordingMode = "instant",
  options?: {
    camera?: { device: string } | { model: string } | null;
    mic_label?: string | null;
    capture_system_audio?: boolean;
  }
): DeepLinkAction {
  return {
    start_recording: {
      capture_mode: captureMode,
      camera: options?.camera ?? null,
      mic_label: options?.mic_label ?? null,
      capture_system_audio: options?.capture_system_audio ?? false,
      mode,
    },
  };
}

export function createStopRecordingAction(): DeepLinkAction {
  return { stop_recording: {} };
}

export function createPauseRecordingAction(): DeepLinkAction {
  return { pause_recording: {} };
}

export function createResumeRecordingAction(): DeepLinkAction {
  return { resume_recording: {} };
}

export function createTogglePauseAction(): DeepLinkAction {
  return { toggle_pause_recording: {} };
}

export function createRestartRecordingAction(): DeepLinkAction {
  return { restart_recording: {} };
}

export function createTakeScreenshotAction(captureMode: CaptureMode): DeepLinkAction {
  return {
    take_screenshot: {
      capture_mode: captureMode,
    },
  };
}

export function createSetMicrophoneAction(label: string | null): DeepLinkAction {
  return {
    set_microphone: {
      label,
    },
  };
}

export function createSetCameraAction(id: { device: string } | { model: string } | null): DeepLinkAction {
  return {
    set_camera: {
      id,
    },
  };
}

export function createListDevicesAction(): DeepLinkAction {
  return { list_devices: {} };
}

export function createGetStatusAction(): DeepLinkAction {
  return { get_status: {} };
}

export function createOpenSettingsAction(page?: string): DeepLinkAction {
  return {
    open_settings: {
      page: page ?? null,
    },
  };
}

export function createOpenEditorAction(projectPath: string): DeepLinkAction {
  return {
    open_editor: {
      project_path: projectPath,
    },
  };
}
