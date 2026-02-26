import { showHUD, open } from "@raycast/api";

const DEEPLINK_SCHEME = "cap-desktop://action";

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
  const action: StartRecordingAction = {
    start_recording: {
      capture_mode: { screen: "Main Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "instant",
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
