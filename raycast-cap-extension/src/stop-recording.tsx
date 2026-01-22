import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { stop_recording: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Stop recording requested" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to stop recording", message: String(error) });
  }
}

