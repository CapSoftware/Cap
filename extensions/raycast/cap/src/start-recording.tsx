import { showToast, Toast, getPreferenceValues } from "@raycast/api";
import { sendDeepLink } from "./utils";

interface Preferences {
  recordingMode: "studio" | "instant";
  captureSystemAudio: boolean;
}

export default async function Command() {
  try {
    const preferences = getPreferenceValues<Preferences>();
    
    await sendDeepLink("start_recording", {
      capture_mode: { Screen: "Primary" },
      camera: null,
      mic_label: null,
      capture_system_audio: preferences.captureSystemAudio ?? false,
      mode: preferences.recordingMode ?? "studio",
    });

    await showToast({
      style: Toast.Style.Success,
      title: "Starting recording...",
    });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to start recording",
      message: String(error),
    });
  }
}
