import { open, showToast, Toast, getApplications } from "@raycast/api";

const CAP_BUNDLE_ID = "so.cap.desktop";
const CAP_DEEPLINK_SCHEME = "cap-desktop";

/**
 * Deep link action types matching the Rust DeepLinkAction enum.
 * Uses snake_case to match serde(rename_all = "snake_case")
 */
export type DeepLinkAction =
  | { start_recording: StartRecordingParams }
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "toggle_pause"
  | { set_microphone: { label: string | null } }
  | { set_camera: { device_id: string | null } }
  | "take_screenshot"
  | { open_editor: { project_path: string } }
  | { open_settings: { page: string | null } }
  | "show_main_window"
  | "list_displays"
  | "list_windows"
  | "list_microphones"
  | "list_cameras"
  | "get_recording_status";

export interface StartRecordingParams {
  capture_mode: CaptureMode;
  camera?: DeviceOrModelID | null;
  mic_label?: string | null;
  capture_system_audio: boolean;
  mode: RecordingMode;
}

// CaptureMode matches Rust enum with snake_case
export type CaptureMode = { screen: string } | { window: string };

// DeviceOrModelID matches Rust enum (PascalCase variants)
export type DeviceOrModelID = { DeviceID: string } | { ModelID: string };

// RecordingMode matches Rust enum with snake_case (lowercase variants)
export type RecordingMode = "instant" | "studio" | "screenshot";

/**
 * Check if Cap is installed on the system
 */
export async function isCapInstalled(): Promise<boolean> {
  const apps = await getApplications();
  return apps.some((app) => app.bundleId === CAP_BUNDLE_ID);
}

/**
 * Build a deeplink URL for a Cap action
 */
export function buildDeeplinkUrl(action: DeepLinkAction): string {
  const actionValue =
    typeof action === "string" ? JSON.stringify(action) : JSON.stringify(action);
  const encodedValue = encodeURIComponent(actionValue);
  return `${CAP_DEEPLINK_SCHEME}://action?value=${encodedValue}`;
}

/**
 * Execute a Cap action via deeplink
 */
export async function executeCapAction(
  action: DeepLinkAction,
  successMessage?: string
): Promise<void> {
  const isInstalled = await isCapInstalled();

  if (!isInstalled) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap Not Found",
      message: "Please install Cap from https://cap.so",
    });
    return;
  }

  const url = buildDeeplinkUrl(action);

  try {
    await open(url);

    if (successMessage) {
      await showToast({
        style: Toast.Style.Success,
        title: successMessage,
      });
    }
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Execute Action",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Open the Cap application
 */
export async function openCap(): Promise<void> {
  const isInstalled = await isCapInstalled();

  if (!isInstalled) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Cap Not Found",
      message: "Please install Cap from https://cap.so",
    });
    return;
  }

  try {
    await open("", CAP_BUNDLE_ID);
    await showToast({
      style: Toast.Style.Success,
      title: "Cap Opened",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to Open Cap",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
