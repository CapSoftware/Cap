import { showHUD, open, getPreferenceValues } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop://action";

interface Preferences {
  displayName?: string;
  recordingMode?: "instant" | "studio";
  captureSystemAudio?: boolean;
}

interface StartRecordingAction {
  start_recording: {
    capture_mode: { screen: string } | { window: string };
    camera: null;
    mic_label: null;
    capture_system_audio: boolean;
    mode: "instant" | "studio";
  };
}

export default async function Command() {
  const preferences = getPreferenceValues<Preferences>();

  // Use configured display name or fall back to empty string
  // Empty string will let Cap use the primary/default display
  const displayName = preferences.displayName?.trim() || "Main Display";
  const recordingMode = preferences.recordingMode || "instant";
  const captureSystemAudio = preferences.captureSystemAudio || false;

  const action: StartRecordingAction = {
    start_recording: {
      capture_mode: { screen: displayName },
      camera: null,
      mic_label: null,
      capture_system_audio: captureSystemAudio,
      mode: recordingMode,
    },
  };

  const jsonValue = JSON.stringify(action);
  const encodedValue = encodeURIComponent(jsonValue);
  const deeplink = `${DEEPLINK_SCHEME}?value=${encodedValue}`;

  try {
    await open(deeplink);
    await showHUD("🔴 Recording started");
  } catch {
    await showHUD("Failed to communicate with Cap. Is it running?");
  }
}
