import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = {
      start_recording: {
        capture_mode: { screen: "Built-in Retina Display" },
        camera: null,
        mic_label: null,
        capture_system_audio: true,
        mode: "Studio"
      }
    };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Recording started" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to start recording", message: String(error) });
  }
}

