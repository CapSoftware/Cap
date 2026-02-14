import { open, showToast, Toast } from "@raycast/api";

const SCHEME = "cap-desktop";

type DeepLinkAction =
  | "stop_recording"
  | "pause_recording"
  | "resume_recording"
  | "toggle_pause"
  | {
      start_recording: {
        capture_mode: { screen: string } | { window: string };
        camera: { DeviceID: string } | { ModelID: string } | null;
        mic_label: string | null;
        capture_system_audio: boolean;
        mode: "studio" | "instant" | "screenshot";
      };
    }
  | { set_camera: { camera: { DeviceID: string } | { ModelID: string } | null } }
  | { set_microphone: { mic_label: string | null } }
  | { open_editor: { project_path: string } }
  | { open_settings: { page: string | null } };

/**
 * Builds a Cap deeplink URL for the given action.
 * Format: cap-desktop://action?value=<json-encoded-action>
 */
function buildDeeplink(action: DeepLinkAction): string {
  const json = JSON.stringify(action);
  return `${SCHEME}://action?value=${encodeURIComponent(json)}`;
}

/**
 * Opens a Cap deeplink. Shows a toast on failure.
 */
export async function openDeeplink(
  action: DeepLinkAction,
  successMessage?: string,
): Promise<void> {
  const url = buildDeeplink(action);
  try {
    await open(url);
    if (successMessage) {
      await showToast({ style: Toast.Style.Success, title: successMessage });
    }
  } catch {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to communicate with Cap",
      message: "Make sure Cap is running",
    });
  }
}
