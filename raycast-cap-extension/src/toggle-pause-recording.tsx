import { open, showToast, Toast } from "@raycast/api";

export default async function Command() {
  try {
    const action = { toggle_pause_recording: {} };
    const url = `cap-desktop://action?value=${encodeURIComponent(JSON.stringify(action))}`;
    await open(url);
    await showToast({ style: Toast.Style.Success, title: "Toggle pause requested" });
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Failed to toggle pause", message: String(error) });
  }
}

