import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  const action = {
    start_recording: {
      capture_mode: { screen: "Main Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "studio",
    },
  };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;

  try {
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Started recording" });
  } catch (error) {
    await showToast({
      style: Toast.Style.Failure,
      title: "Failed to start recording",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

export default async function Command() {
  const action = {
    start_recording: {
      capture_mode: { screen: "Main Display" },
      camera: null,
      mic_label: null,
      capture_system_audio: false,
      mode: "studio",
    },
  };

  const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
  await open(url);
}
