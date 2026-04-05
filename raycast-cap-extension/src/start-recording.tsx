import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = {
      start_recording: {
        capture_mode: { screen: "" },
        camera: null,
        mic_label: null,
        capture_system_audio: true,
        mode: "studio"
      }
    };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Start recording requested" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to start recording", message: String(error) });
  }
}

